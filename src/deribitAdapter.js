// ===== deribitAdapter.js =====
// Minimal WebSocket adapter for Deribit live data (mainnet). Works in browser.
// Usage:
//   import { DeribitAdapter } from './deribitAdapter.js'
//   const da = new DeribitAdapter({ onUnderlying, onOptionTicker })
//   await da.connect()
//   await da.subscribeUnderlying('BTC-PERPETUAL')
//   await da.autoSubscribeATM({ currency: 'BTC', kind: 'option', expiryDays: 7 })
//
//   // or subscribe a specific option explicitly:
//   await da.subscribeOption('BTC-27SEP24-65000-C')

export class DeribitAdapter {
    constructor({ onUnderlying, onOptionTicker } = {}) {
      this.ws = null
      this.reqId = 1
      this.pending = new Map()
      this.subs = new Set()
      this.onUnderlying = onUnderlying || (()=>{})
      this.onOptionTicker = onOptionTicker || (()=>{})
    }
  
    _send(method, params) {
      const id = this.reqId++
      const payload = { jsonrpc: '2.0', id, method, params }
      this.ws.send(JSON.stringify(payload))
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject })
        // optional: timeout
        setTimeout(()=>{
          if (this.pending.has(id)) {
            this.pending.get(id).reject(new Error('Deribit request timeout'))
            this.pending.delete(id)
          }
        }, 10000)
      })
    }
  
    async connect({ testnet=false } = {}) {
      const url = testnet ? 'wss://test.deribit.com/ws/api/v2' : 'wss://www.deribit.com/ws/api/v2'
      this.ws = new WebSocket(url)
      await new Promise((resolve, reject) => {
        this.ws.onopen = resolve
        this.ws.onerror = reject
      })
      this.ws.onmessage = (evt) => {
        const msg = JSON.parse(evt.data)
        if (msg.method === 'subscription') {
          const { channel, data } = msg.params || {}
          if (!channel) return
          if (channel.startsWith('ticker.')) {
            // underlying_price and mark_iv are provided on option tickers
            if (typeof data.index_price === 'number' && data.instrument_name && data.instrument_name.includes('PERPETUAL')) {
              this.onUnderlying({ symbol: data.instrument_name, price: data.index_price })
            }
            if (typeof data.underlying_price === 'number') {
              this.onUnderlying({ symbol: 'UNDERLYING', price: data.underlying_price })
            }
            // Option mark IV and bid/ask
            if (data.instrument_name && (typeof data.mark_iv === 'number' || typeof data.best_bid_price === 'number' || typeof data.best_ask_price === 'number')) {
              this.onOptionTicker({
                instrument: data.instrument_name,
                markIv: data.mark_iv,            // decimal (e.g., 0.45)
                markPrice: data.mark_price,
                bestBid: data.best_bid_price,
                bestAsk: data.best_ask_price,
                underlying: data.underlying_price,
                timestamp: data.timestamp
              })
            }
          }
        } else if (Object.prototype.hasOwnProperty.call(msg, 'id')) {
          const p = this.pending.get(msg.id)
          if (p) {
            this.pending.delete(msg.id)
            if (msg.error) p.reject(new Error(msg.error.message))
            else p.resolve(msg.result)
          }
        }
      }
    }
  
    async subscribeUnderlying(symbol = 'BTC-PERPETUAL') {
      await this._send('public/subscribe', { channels: [`ticker.${symbol}.raw`] })
    }
  
    async subscribeOption(instrument) {
      if (this.subs.has(instrument)) return
      this.subs.add(instrument)
      await this._send('public/subscribe', { channels: [`ticker.${instrument}.raw`] })
    }
  
    async listInstruments({ currency='BTC', kind='option', expired=false } = {}) {
      return await this._send('public/get_instruments', { currency, kind, expired })
    }
  
    // Auto-pick an ATM-ish option around a target expiry horizon (in days)
    async autoSubscribeATM({ currency='BTC', expiryDays=7 } = {}) {
      const instruments = await this.listInstruments({ currency, kind: 'option', expired:false })
      // Choose nearest expiry to target days and then the strike closest to current index price
      const index = await this._send('public/get_index_price', { index_name: `${currency}-USD` })
      const spot = index.index_price
  
      // Parse expiries, filter calls & puts near ATM
      const byExpiry = new Map()
      for (const ins of instruments) {
        // instrument_name like BTC-27SEP24-65000-C
        const tMs = ins.expiration_timestamp
        if (!byExpiry.has(tMs)) byExpiry.set(tMs, [])
        byExpiry.get(tMs).push(ins)
      }
      const now = Date.now()
      let bestExp = null, bestDiff = Infinity
      for (const [tMs] of byExpiry) {
        const d = (tMs - now) / (1000*60*60*24)
        const diff = Math.abs(d - expiryDays)
        if (diff < bestDiff) { bestDiff = diff; bestExp = tMs }
      }
      if (!bestExp) return null
      const list = byExpiry.get(bestExp)
      // pick strike closest to spot for a call and a put, subscribe both
      let bestCall=null, bestPut=null, callDiff=Infinity, putDiff=Infinity
      for (const ins of list) {
        const diff = Math.abs(ins.strike - spot)
        if (ins.option_type === 'call' && diff < callDiff) { bestCall = ins; callDiff = diff }
        if (ins.option_type === 'put'  && diff < putDiff)  { bestPut  = ins; putDiff  = diff }
      }
      if (bestCall) await this.subscribeOption(bestCall.instrument_name)
      if (bestPut)  await this.subscribeOption(bestPut.instrument_name)
      return { call: bestCall?.instrument_name, put: bestPut?.instrument_name, spot }
    }
  
    close(){ try { this.ws?.close() } catch(_){} }
  }
  
  
  // ===== OMMInteractive integration snippet (add to your OMMInteractive.jsx) =====
  // import { useEffect } from 'react'
  // import { DeribitAdapter } from './deribitAdapter.js'
  /*
  useEffect(() => {
    const da = new DeribitAdapter({
      onUnderlying: ({ price }) => {
        if (typeof price === 'number') setF(price)
      },
      onOptionTicker: ({ markIv }) => {
        if (typeof markIv === 'number') setAtmVolPct(markIv * 100)
      }
    })
    da.connect({ testnet: false }).then(async () => {
      await da.subscribeUnderlying('BTC-PERPETUAL')
      // auto-pick near-ATM options around 7 days
      await da.autoSubscribeATM({ currency: 'BTC', expiryDays: 7 })
    })
    return () => da.close()
  }, [])
  */
  
  
  // ===== Optional: Alpha Vantage polling adapter (FX proxy if you just want live F) =====
  // Requires an API key: https://www.alphavantage.co
  //   const av = makeAlphaVantageAdapter({ apiKey: 'YOUR_KEY', symbol: 'GBPUSD' })
  //   av.start((px)=> setF(px))
  export function makeAlphaVantageAdapter({ apiKey, symbol = 'GBPUSD', interval = 60 }) {
    let timer
    async function fetchLast() {
      try {
        const url = `https://www.alphavantage.co/query?function=FX_INTRADAY&from_symbol=${symbol.slice(0,3)}&to_symbol=${symbol.slice(3)}&interval=1min&apikey=${apiKey}`
        const res = await fetch(url)
        const json = await res.json()
        const series = json['Time Series FX (1min)'] || {}
        const first = Object.values(series)[0]
        const px = first ? parseFloat(first['4. close']) : undefined
        return px
      } catch { return undefined }
    }
    return {
      start(onPx){
        const loop = async () => {
          const px = await fetchLast()
          if (typeof px === 'number') onPx(px)
        }
        loop()
        timer = setInterval(loop, interval*1000)
      },
      stop(){ if (timer) clearInterval(timer) }
    }
  }
  