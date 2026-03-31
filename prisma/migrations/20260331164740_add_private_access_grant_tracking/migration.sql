-- CreateTable
CREATE TABLE "PrivateAccessGrant" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "channelTelegramId" TEXT NOT NULL,
    "inviteLink" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrivateAccessGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PrivateAccessGrant_channelTelegramId_userId_isActive_idx" ON "PrivateAccessGrant"("channelTelegramId", "userId", "isActive");

-- CreateIndex
CREATE INDEX "PrivateAccessGrant_userId_createdAt_idx" ON "PrivateAccessGrant"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "PrivateAccessGrant" ADD CONSTRAINT "PrivateAccessGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
