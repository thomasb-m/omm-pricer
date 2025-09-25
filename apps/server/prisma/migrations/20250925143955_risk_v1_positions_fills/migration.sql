-- CreateTable
CREATE TABLE "Position" (
    "instrument" TEXT NOT NULL PRIMARY KEY,
    "qty" REAL NOT NULL,
    "avgPrice" REAL NOT NULL,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Fill" (
    "id" BIGINT NOT NULL PRIMARY KEY,
    "tsMs" BIGINT NOT NULL,
    "instrument" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "price" REAL NOT NULL,
    "qty" REAL NOT NULL,
    "fee" REAL
);
