-- CreateTable
CREATE TABLE "Instrument" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "strike" REAL,
    "optionType" TEXT,
    "expiryMs" BIGINT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Ticker" (
    "id" BIGINT NOT NULL PRIMARY KEY,
    "tsMs" BIGINT NOT NULL,
    "instrument" TEXT NOT NULL,
    "markIv" REAL,
    "markPrice" REAL,
    "bestBid" REAL,
    "bestAsk" REAL,
    "underlying" REAL
);

-- CreateTable
CREATE TABLE "TickIndex" (
    "id" BIGINT NOT NULL PRIMARY KEY,
    "tsMs" BIGINT NOT NULL,
    "indexName" TEXT NOT NULL,
    "price" REAL NOT NULL
);

-- CreateTable
CREATE TABLE "Trade" (
    "id" BIGINT NOT NULL PRIMARY KEY,
    "tsMs" BIGINT NOT NULL,
    "instrument" TEXT NOT NULL,
    "price" REAL NOT NULL,
    "size" REAL NOT NULL,
    "side" TEXT,
    "tradeId" TEXT
);

-- CreateIndex
CREATE UNIQUE INDEX "Instrument_name_key" ON "Instrument"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Trade_tradeId_key" ON "Trade"("tradeId");
