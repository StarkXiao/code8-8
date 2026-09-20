-- AlterTable
ALTER TABLE "AudioAttachment" ADD COLUMN "replacements" TEXT;
ALTER TABLE "AudioAttachment" ADD COLUMN "transcriptRaw" TEXT;

-- CreateTable
CREATE TABLE "GlossaryEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "dialect" TEXT NOT NULL,
    "standard" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'dialect',
    "note" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GlossaryEntry_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GlossaryEntry_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "GlossaryEntry_workspaceId_enabled_idx" ON "GlossaryEntry"("workspaceId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "GlossaryEntry_workspaceId_dialect_key" ON "GlossaryEntry"("workspaceId", "dialect");
