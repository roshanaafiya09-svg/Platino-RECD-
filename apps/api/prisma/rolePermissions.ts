import { ROLE_KEY, PERMISSION_KEY } from "@recd/shared";

/**
 * The default permissions of every built-in role. This is what prisma/seed.ts writes into the database (it only ever ADDS missing
 * role-permission links; it never removes one), and what test/rolePermissions.test.ts checks, so a change to who may do what is one visible edit here.
 *
 * Settings (the Settings page and every route behind it) needs MANAGE_SETTINGS: Super Admin, Owner / Admin and Management hold it, nobody else.
 */
export interface RoleDefinition {
  name: string;
  description: string;
  permissions: string[];
}

export const ALL_PERMISSIONS: string[] = Object.values(PERMISSION_KEY);

export const ROLE_DEFINITIONS: Record<string, RoleDefinition> = {
  [ROLE_KEY.SUPER_ADMIN]: {
    name: "Super Admin",
    description: "Root-level administrator. Full access to settings, user management, and configuration.",
    permissions: ALL_PERMISSIONS,
  },
  [ROLE_KEY.OWNER_ADMIN]: {
    name: "Owner / Admin",
    description: "Proprietor, Owner, CEO, or CTO. Full standard administrative permissions.",
    // Everything they already had, plus MANAGE_SETTINGS (the Settings page and its API routes).
    permissions: [...ALL_PERMISSIONS],
  },
  [ROLE_KEY.MANAGEMENT]: {
    name: "Management",
    description: "Senior managers below owner level. Full standard administrative permissions.",
    // Everything they already had, plus MANAGE_SETTINGS (the Settings page and its API routes).
    permissions: [...ALL_PERMISSIONS],
  },
  [ROLE_KEY.SALES]: {
    name: "Sales",
    description: "Creates orders, views customer project progress.",
    permissions: [PERMISSION_KEY.MANAGE_ORDERS, PERMISSION_KEY.VIEW_SITE_STATUS],
  },
  [ROLE_KEY.OPERATIONS_PM]: {
    name: "Operations / Project Manager",
    description: "Assigns engineers, updates plans, tracks pending items.",
    permissions: [PERMISSION_KEY.VIEW_SITE_STATUS, PERMISSION_KEY.CHANGE_SITE_STATUS, PERMISSION_KEY.RESOLVE_PENDING_ACTION],
  },
  [ROLE_KEY.ERECTION_ENGINEER]: {
    name: "Erection Engineer",
    description: "Updates site progress on the ground. Oversees all erection-stage field work (fitters/welders are informal titles under this role, not separate roles). Resolves complaints assigned to them.",
    permissions: [PERMISSION_KEY.VIEW_SITE_STATUS, PERMISSION_KEY.CHANGE_SITE_STATUS, PERMISSION_KEY.ACT_ASSIGNED_COMPLAINTS],
  },
  [ROLE_KEY.COMMISSIONING_ENGINEER]: {
    name: "Commissioning Engineer",
    description: "Updates commissioning stages, uploads test reports. Resolves complaints assigned to them.",
    permissions: [PERMISSION_KEY.VIEW_SITE_STATUS, PERMISSION_KEY.CHANGE_SITE_STATUS, PERMISSION_KEY.ACT_ASSIGNED_COMPLAINTS],
  },
  [ROLE_KEY.SERVICE_TEAM]: {
    name: "Service Team",
    description: "Handles and resolves customer complaints day to day.",
    permissions: [PERMISSION_KEY.MANAGE_COMPLAINTS, PERMISSION_KEY.VIEW_SITE_STATUS],
  },
  [ROLE_KEY.FINANCE]: {
    name: "Finance",
    description: "Order value, invoicing, payment status - module deferred to Phase 2.",
    permissions: [],
  },
  [ROLE_KEY.REGIONAL_MANAGER]: {
    name: "Regional Manager",
    description: "Owns service activity for the regions mapped to them: receives reminders and escalations for their regions.",
    permissions: [PERMISSION_KEY.VIEW_SITE_STATUS, PERMISSION_KEY.MANAGE_COMPLAINTS, PERMISSION_KEY.VIEW_COMPLAINTS_OVERVIEW, PERMISSION_KEY.VIEW_DASHBOARD],
  },
  [ROLE_KEY.SERVICE_MANAGER]: {
    name: "Service Manager",
    description: "Runs the service desk: manages and assigns customer tickets.",
    permissions: [PERMISSION_KEY.VIEW_SITE_STATUS, PERMISSION_KEY.MANAGE_COMPLAINTS, PERMISSION_KEY.VIEW_COMPLAINTS_OVERVIEW, PERMISSION_KEY.VIEW_DASHBOARD],
  },
  [ROLE_KEY.SERVICE_ENGINEER]: {
    name: "Service Engineer",
    description: "Field service engineer: works tickets assigned to them.",
    permissions: [PERMISSION_KEY.VIEW_SITE_STATUS, PERMISSION_KEY.ACT_ASSIGNED_COMPLAINTS],
  },
  [ROLE_KEY.CUSTOMER]: {
    name: "Customer",
    description: "Views only their own orders/sites, raises complaints, resolves their own pending actions.",
    permissions: [PERMISSION_KEY.VIEW_SITE_STATUS, PERMISSION_KEY.RAISE_COMPLAINT, PERMISSION_KEY.RESOLVE_PENDING_ACTION],
  },
};
