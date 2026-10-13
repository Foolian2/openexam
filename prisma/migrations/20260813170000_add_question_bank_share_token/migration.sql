-- AlterTable
ALTER TABLE "QuestionBankItem" ADD COLUMN "shareToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "QuestionBankItem_shareToken_key" ON "QuestionBankItem"("shareToken");
