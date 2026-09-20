-- AlterTable
ALTER TABLE "AudioAttachment" ADD COLUMN "transcriptRaw" TEXT;
ALTER TABLE "AudioAttachment" ADD COLUMN "transcriptReplacements" TEXT;

-- CreateTable
CREATE TABLE "GlossaryTerm" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "replacement" TEXT NOT NULL,
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GlossaryTerm_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GlossaryTerm_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "GlossaryTerm_workspaceId_term_key" ON "GlossaryTerm"("workspaceId", "term");
