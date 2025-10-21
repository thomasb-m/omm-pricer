-- CreateTable
CREATE TABLE "Instrument" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "strike" REAL,
    "optionType" TEXT,
    "expiryMs" BIGINT,
    "expirationTimestamp" BIGINT,
    "instrument" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Ticker" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instrument" TEXT NOT NULL,
    "tsMs" BIGINT NOT NULL,
    "bid" REAL,
    "ask" REAL,
    "mid" REAL,
    "markIV" REAL,
    "markPrice" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "BtcIndex" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "price" REAL NOT NULL,
    "timestamp" BIGINT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "TickIndex" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "indexName" TEXT NOT NULL,
    "price" REAL NOT NULL,
    "tsMs" BIGINT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Position" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instrument" TEXT NOT NULL,
    "qty" REAL NOT NULL,
    "avgPrice" REAL NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "MarketSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "symbol" TEXT NOT NULL,
    "timestamp" BIGINT NOT NULL,
    "data" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "Instrument_instrument_key" ON "Instrument"("instrument");

-- CreateIndex
CREATE INDEX "Instrument_kind_idx" ON "Instrument"("kind");

-- CreateIndex
CREATE INDEX "Instrument_expiryMs_idx" ON "Instrument"("expiryMs");

-- CreateIndex
CREATE INDEX "Ticker_instrument_tsMs_idx" ON "Ticker"("instrument", "tsMs");

-- CreateIndex
CREATE INDEX "Ticker_tsMs_idx" ON "Ticker"("tsMs");

-- CreateIndex
CREATE INDEX "BtcIndex_timestamp_idx" ON "BtcIndex"("timestamp");

-- CreateIndex
CREATE INDEX "TickIndex_indexName_tsMs_idx" ON "TickIndex"("indexName", "tsMs");

-- CreateIndex
CREATE UNIQUE INDEX "Position_instrument_key" ON "Position"("instrument");

-- CreateIndex
CREATE INDEX "Position_instrument_idx" ON "Position"("instrument");

-- CreateIndex
CREATE INDEX "MarketSnapshot_symbol_timestamp_idx" ON "MarketSnapshot"("symbol", "timestamp");
