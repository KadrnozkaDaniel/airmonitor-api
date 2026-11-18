/*
  Warnings:

  - A unique constraint covering the columns `[apiKeyHash]` on the table `Device` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Device" ADD COLUMN     "apiKeyHash" TEXT,
ADD COLUMN     "lastSeenAt" TIMESTAMPTZ(3);

-- CreateIndex
CREATE UNIQUE INDEX "Device_apiKeyHash_key" ON "Device"("apiKeyHash");
