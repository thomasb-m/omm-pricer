/*
  Warnings:

  - You are about to drop the `Fill` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Instrument` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `MarketSnapshot` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Position` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `TickIndex` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Ticker` table. If the table is not empty, all the data it contains will be lost.
  - The primary key for the `Trade` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `instrument` on the `Trade` table. All the data in the column will be lost.
  - You are about to drop the column `size` on the `Trade` table. All the data in the column will be lost.
  - You are about to drop the column `tradeId` on the `Trade` table. All the data in the column will be lost.
  - You are about to drop the column `tsMs` on the `Trade` table. All the data in the column will be lost.
  - Added the required column `F` to the `Trade` table without a default value. This is not possible if the table is not empty.
  - Added the required column `K` to the `Trade` table without a default value. This is not possible if the table is not empty.
  - Added the required column `dotLamG` to the `Trade` table without a default value. This is not possible if the table is not empty.
  - Added the required column `expiryMs` to the `Trade` table without a default value. This is not possible if the table is not empty.
  - Added the required column `gJson` to the `Trade` table without a default value. This is not possible if the table is not empty.
  - Added the required column `gLambdaG` to the `Trade` table without a default value. This is not possible if the table is not empty.
  - Added the required column `pnlEst` to the `Trade` table without a default value. This is not possible if the table is not empty.
  - Added the required column `qty` to the `Trade` table without a default value. This is not possible if the table is not empty.
  - Added the required column `runId` to the `Trade` table without a default value. This is not possible if the table is not empty.
  - Added the required column `symbol` to the `Trade` table without a default value. This is not possible if the table is not empty.
  - Made the column `side` on table `Trade` required. This step will fail if there are existing NULL values in that column.

*/
-- DropIndex
DROP INDEX "Instrument_name_key";

-- DropIndex
DROP INDEX "MarketSnapshot_timestamp_symbol_idx";

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "Fill";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "Instrument";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "MarketSnapshot";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "Position";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "TickIndex";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "Ticker";
PRAGMA foreign_keys=on;

-- CreateTable
CREATE TABLE "Run" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    "configJson" JSONB NOT NULL,
    "configHash" TEXT NOT NULL,
    "factorVersion" INTEGER NOT NULL
);

-- CreateTable
CREATE TABLE "Quote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "ts" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "symbol" TEXT NOT NULL,
    "expiryMs" BIGINT NOT NULL,
    "strike" REAL NOT NULL,
    "theoRaw" REAL NOT NULL,
    "theoInv" REAL NOT NULL,
    "skew" REAL NOT NULL,
    "bid" REAL NOT NULL,
    "ask" REAL NOT NULL,
    "sizeBid" REAL NOT NULL,
    "sizeAsk" REAL NOT NULL,
    "mid" REAL NOT NULL,
    "gJson" JSONB NOT NULL,
    "spreadJson" JSONB NOT NULL,
    "gLambdaG" REAL NOT NULL,
    "invUtil" REAL NOT NULL,
    "factorContribJson" JSONB,
    CONSTRAINT "Quote_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "InventorySnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "ts" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "symbol" TEXT NOT NULL,
    "IJson" JSONB NOT NULL,
    "lambdaJson" JSONB NOT NULL,
    "notional" REAL NOT NULL,
    "vega" REAL NOT NULL,
    "gamma" REAL NOT NULL,
    "invNorm" REAL NOT NULL,
    "invUtil" REAL NOT NULL,
    CONSTRAINT "InventorySnapshot_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RiskMetrics" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "ts" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "symbol" TEXT NOT NULL,
    "horizonMs" INTEGER NOT NULL,
    "SigmaJson" JSONB NOT NULL,
    "traceValue" REAL NOT NULL,
    "condNumber" REAL NOT NULL,
    "isPD" BOOLEAN NOT NULL,
    "minDiag" REAL NOT NULL,
    "maxDiag" REAL NOT NULL,
    "samples" INTEGER NOT NULL,
    "gamma" REAL NOT NULL,
    "z" REAL NOT NULL,
    "eta" REAL NOT NULL,
    "kappa" REAL NOT NULL,
    "L" REAL NOT NULL,
    "ridgeEps" REAL NOT NULL,
    CONSTRAINT "RiskMetrics_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "ts" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metaJson" JSONB,
    CONSTRAINT "Event_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Trade" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "ts" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "qty" REAL NOT NULL,
    "price" REAL NOT NULL,
    "F" REAL NOT NULL,
    "K" REAL NOT NULL,
    "expiryMs" BIGINT NOT NULL,
    "gJson" JSONB NOT NULL,
    "dotLamG" REAL NOT NULL,
    "gLambdaG" REAL NOT NULL,
    "pnlEst" REAL NOT NULL,
    "edge" REAL,
    CONSTRAINT "Trade_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Trade" ("id", "price", "side") SELECT "id", "price", "side" FROM "Trade";
DROP TABLE "Trade";
ALTER TABLE "new_Trade" RENAME TO "Trade";
CREATE INDEX "Trade_runId_ts_idx" ON "Trade"("runId", "ts");
CREATE INDEX "Trade_symbol_ts_idx" ON "Trade"("symbol", "ts");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Run_startedAt_idx" ON "Run"("startedAt");

-- CreateIndex
CREATE INDEX "Run_configHash_idx" ON "Run"("configHash");

-- CreateIndex
CREATE INDEX "Quote_runId_ts_idx" ON "Quote"("runId", "ts");

-- CreateIndex
CREATE INDEX "Quote_symbol_ts_idx" ON "Quote"("symbol", "ts");

-- CreateIndex
CREATE INDEX "InventorySnapshot_runId_ts_idx" ON "InventorySnapshot"("runId", "ts");

-- CreateIndex
CREATE INDEX "InventorySnapshot_symbol_ts_idx" ON "InventorySnapshot"("symbol", "ts");

-- CreateIndex
CREATE INDEX "RiskMetrics_runId_ts_idx" ON "RiskMetrics"("runId", "ts");

-- CreateIndex
CREATE INDEX "RiskMetrics_symbol_ts_idx" ON "RiskMetrics"("symbol", "ts");

-- CreateIndex
CREATE INDEX "Event_runId_ts_idx" ON "Event"("runId", "ts");

-- CreateIndex
CREATE INDEX "Event_level_ts_idx" ON "Event"("level", "ts");

-- CreateIndex
CREATE INDEX "Event_code_idx" ON "Event"("code");
