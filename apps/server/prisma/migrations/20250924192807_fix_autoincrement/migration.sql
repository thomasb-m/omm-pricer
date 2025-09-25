/*
  Warnings:

  - The primary key for the `TickIndex` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to alter the column `id` on the `TickIndex` table. The data in that column could be lost. The data in that column will be cast from `BigInt` to `Int`.
  - The primary key for the `Ticker` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to alter the column `id` on the `Ticker` table. The data in that column could be lost. The data in that column will be cast from `BigInt` to `Int`.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_TickIndex" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "tsMs" BIGINT NOT NULL,
    "indexName" TEXT NOT NULL,
    "price" REAL NOT NULL
);
INSERT INTO "new_TickIndex" ("id", "indexName", "price", "tsMs") SELECT "id", "indexName", "price", "tsMs" FROM "TickIndex";
DROP TABLE "TickIndex";
ALTER TABLE "new_TickIndex" RENAME TO "TickIndex";
CREATE TABLE "new_Ticker" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "tsMs" BIGINT NOT NULL,
    "instrument" TEXT NOT NULL,
    "markIv" REAL,
    "markPrice" REAL,
    "bestBid" REAL,
    "bestAsk" REAL,
    "underlying" REAL
);
INSERT INTO "new_Ticker" ("bestAsk", "bestBid", "id", "instrument", "markIv", "markPrice", "tsMs", "underlying") SELECT "bestAsk", "bestBid", "id", "instrument", "markIv", "markPrice", "tsMs", "underlying" FROM "Ticker";
DROP TABLE "Ticker";
ALTER TABLE "new_Ticker" RENAME TO "Ticker";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
