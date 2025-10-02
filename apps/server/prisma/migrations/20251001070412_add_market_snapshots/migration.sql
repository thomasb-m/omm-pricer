-- CreateTable
CREATE TABLE "MarketSnapshot" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "timestamp" BIGINT NOT NULL,
    "symbol" TEXT NOT NULL,
    "data" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX "MarketSnapshot_timestamp_symbol_idx" ON "MarketSnapshot"("timestamp", "symbol");
