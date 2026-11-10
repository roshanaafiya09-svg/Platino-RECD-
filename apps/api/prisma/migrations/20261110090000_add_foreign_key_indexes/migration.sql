-- Additive only: indexes on foreign-key columns that are joined or filtered (Supabase performance advisor "unindexed foreign keys").
-- Purely a performance change: no table, column or constraint changes, no data touched. Safe to run on a live database - the tables are small and
-- CREATE INDEX only blocks writes to the table for the moment it takes. IF NOT EXISTS makes a re-run harmless.
-- Deliberately NOT indexed: "who did it" columns (createdById, actorId, closedById, archivedById, signedById ...) - written once, never filtered
-- on, and their parent rows (users) are deactivated, never deleted.
-- Rollback: DROP INDEX IF EXISTS "<name>"; for each index below.

CREATE INDEX IF NOT EXISTS "AmcOrder_customerId_idx" ON "AmcOrder"("customerId");
CREATE INDEX IF NOT EXISTS "Complaint_customerId_idx" ON "Complaint"("customerId");
CREATE INDEX IF NOT EXISTS "Complaint_assignedToId_idx" ON "Complaint"("assignedToId");
CREATE INDEX IF NOT EXISTS "Customer_salesOwnerId_idx" ON "Customer"("salesOwnerId");
CREATE INDEX IF NOT EXISTS "Order_productId_idx" ON "Order"("productId");
CREATE INDEX IF NOT EXISTS "Order_salesEngineerId_idx" ON "Order"("salesEngineerId");
CREATE INDEX IF NOT EXISTS "OrderLineItem_orderId_idx" ON "OrderLineItem"("orderId");
CREATE INDEX IF NOT EXISTS "OrderLineItem_productId_idx" ON "OrderLineItem"("productId");
CREATE INDEX IF NOT EXISTS "PendingAction_siteId_idx" ON "PendingAction"("siteId");
CREATE INDEX IF NOT EXISTS "PendingAction_ownerUserId_idx" ON "PendingAction"("ownerUserId");
CREATE INDEX IF NOT EXISTS "RecdDelivery_productId_idx" ON "RecdDelivery"("productId");
CREATE INDEX IF NOT EXISTS "RecdUnit_lineItemId_idx" ON "RecdUnit"("lineItemId");
CREATE INDEX IF NOT EXISTS "RecdUnit_productId_idx" ON "RecdUnit"("productId");
CREATE INDEX IF NOT EXISTS "RolePermission_permissionId_idx" ON "RolePermission"("permissionId");
CREATE INDEX IF NOT EXISTS "ServiceReminder_customerId_idx" ON "ServiceReminder"("customerId");
CREATE INDEX IF NOT EXISTS "ServiceReminder_siteId_idx" ON "ServiceReminder"("siteId");
CREATE INDEX IF NOT EXISTS "ServiceReminder_unitId_idx" ON "ServiceReminder"("unitId");
CREATE INDEX IF NOT EXISTS "Site_assignedEngineerId_idx" ON "Site"("assignedEngineerId");
CREATE INDEX IF NOT EXISTS "Site_currentStageId_idx" ON "Site"("currentStageId");
CREATE INDEX IF NOT EXISTS "Site_regionId_idx" ON "Site"("regionId");
CREATE INDEX IF NOT EXISTS "Site_structureTypeId_idx" ON "Site"("structureTypeId");
CREATE INDEX IF NOT EXISTS "Site_vendorId_idx" ON "Site"("vendorId");
CREATE INDEX IF NOT EXISTS "SiteContact_siteId_idx" ON "SiteContact"("siteId");
CREATE INDEX IF NOT EXISTS "SiteDocumentRequirement_requirementTypeId_idx" ON "SiteDocumentRequirement"("requirementTypeId");
CREATE INDEX IF NOT EXISTS "SitePhoto_checkpointId_idx" ON "SitePhoto"("checkpointId");
CREATE INDEX IF NOT EXISTS "SitePhoto_siteId_idx" ON "SitePhoto"("siteId");
CREATE INDEX IF NOT EXISTS "SiteStageEvent_siteId_idx" ON "SiteStageEvent"("siteId");
CREATE INDEX IF NOT EXISTS "SiteStageEvent_stageDefinitionId_idx" ON "SiteStageEvent"("stageDefinitionId");
CREATE INDEX IF NOT EXISTS "SiteStageEvent_statusOptionId_idx" ON "SiteStageEvent"("statusOptionId");
CREATE INDEX IF NOT EXISTS "StructureTemplateExample_structureTypeId_idx" ON "StructureTemplateExample"("structureTypeId");
CREATE INDEX IF NOT EXISTS "User_roleId_idx" ON "User"("roleId");
CREATE INDEX IF NOT EXISTS "User_customerId_idx" ON "User"("customerId");
CREATE INDEX IF NOT EXISTS "User_vendorId_idx" ON "User"("vendorId");
