-- AlterTable
ALTER TABLE "Question" ADD COLUMN     "bankItemId" TEXT;

-- CreateTable
CREATE TABLE "QuestionBankItem" (
    "id" TEXT NOT NULL,
    "type" "QuestionType" NOT NULL,
    "title" TEXT NOT NULL,
    "points" DOUBLE PRECISION NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL,
    "creatorId" TEXT NOT NULL,
    "folderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuestionBankItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QuestionBankItem_creatorId_idx" ON "QuestionBankItem"("creatorId");

-- CreateIndex
CREATE INDEX "QuestionBankItem_folderId_idx" ON "QuestionBankItem"("folderId");

-- CreateIndex
CREATE INDEX "Question_bankItemId_idx" ON "Question"("bankItemId");

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_bankItemId_fkey" FOREIGN KEY ("bankItemId") REFERENCES "QuestionBankItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionBankItem" ADD CONSTRAINT "QuestionBankItem_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionBankItem" ADD CONSTRAINT "QuestionBankItem_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "Folder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
