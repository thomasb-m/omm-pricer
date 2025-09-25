import WebSocket from "ws";

type Pending = { resolve: (v:any)=>void; reject: (e:any)=>void };

function networkUrl(net: string | undefined) {
  return net === "testnet"
    ? "wss://test.deribit.com/ws/api/v2"
    : "wss://www.deribit.com/ws/api/v2"; // default mainnet
}

export class DeribitWS {
  private ws!: WebSocket;
  private id = 1;
  private pending = new Map<number, Pending>();
  constructor(private onSub?: (channel: string, data: any) => void) {}

  async connect(networkEnv?: string) {
    const url = networkUrl(networkEnv);
    this.ws = new WebSocket(url);

    await new Promise<void>((resolve, reject) => {
      this.ws.once("open", () => { console.log("[deribit] ws open:", url); resolve(); });
      this.ws.once("error", (e) => { console.error("[deribit] ws open error:", e); reject(e); });
    });

    this.ws.on("error", (e) => console.error("[deribit] ws error:", e));
    this.ws.on("close", (code, reason) => {
      console.warn("[deribit] ws closed", code, reason.toString());
    });

    this.ws.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (Object.prototype.hasOwnProperty.call(msg, "id") && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) { console.error("[deribit] rpc error", msg.error); p.reject(msg.error); }
        else { p.resolve(msg.result); }
        return;
      }
      if (msg.method === "subscription" && this.onSub) {
        const ch = msg.params?.channel ?? "";
        const data = msg.params?.data;
        this.onSub(ch, data);
      }
    });
  }

  private rpc(method: string, params: Record<string, any> = {}) {
    const id = this.id++;
    const payload = { jsonrpc: "2.0", id, method, params };
    this.ws.send(JSON.stringify(payload));
    return new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          console.error("[deribit] rpc timeout:", method);
          this.pending.get(id)!.reject(new Error("RPC timeout"));
          this.pending.delete(id);
        }
      }, 10_000);
    });
  }

  async subscribe(channels: string[]) {
    console.log("[deribit] subscribe", channels);
    const res = await this.rpc("public/subscribe", { channels });
    return res;
    // NOTE: we use public *.100ms channels (no auth), not *.raw
  }
  getInstruments(currency="BTC", kind="option", expired=false) {
    return this.rpc("public/get_instruments", { currency, kind, expired });
  }
  getIndexPrice(index_name="btc_usd") {
    return this.rpc("public/get_index_price", { index_name });
  }
}