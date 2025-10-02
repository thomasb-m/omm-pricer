Got it 👍 — here’s a nice **README note** you can drop into `apps/server/README.md` (or just keep handy in your head before bed):

---

# OMM Pricer – Dev Notes

### Running the server

```bash
cd apps/server
npm run dev
```

Runs the Fastify server on `http://localhost:3001`.

### Key Endpoints

* **Quote**:

  ```bash
  curl -s -X POST http://localhost:3001/quote \
    -H "Content-Type: application/json" \
    -d '{"symbol":"BTC","strike":45000,"expiryMs":1761264000000,"optionType":"C","marketIV":0.31}' | jq
  ```
* **Execute trade** (customer perspective):

  ```bash
  curl -s -X POST http://localhost:3001/trade/execute \
    -H "Content-Type: application/json" \
    -d '{"symbol":"BTC","strike":45000,"expiryMs":1761264000000,"optionType":"C","side":"BUY","size":2,"price":100}' | jq
  ```
* **Inventory summary**:

  ```bash
  curl -s "http://localhost:3001/inventory?symbol=BTC" | jq
  ```

### Running tests

From project root:

```bash
npm run test:server
```

* All tests now pass ✅ (5/5 suites, 13/13 tests).
* Debug logs show `black76Greeks` input sanity.

### Notes

* `IntegratedSmileModel` now guards against insane prices (negative/huge).
* `proxyMid` + `sanePrice` provide fallback values.
* Inventory updates shift PC surface relative to CC.
* Debug logging (`[b76 cc]`, `[b76 pc]`, `[b76 trade]`, `[b76 node]`) is left in for validation during live tests.

---

✨ You’re in a good place to pick up tomorrow: everything’s in `main`, tests are green, logging is live.

Want me to also add a **next steps / TODO list** section so you know what to tackle when you sit down next?
