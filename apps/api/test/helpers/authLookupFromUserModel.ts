/**
 * `authenticate` reads the account, its role key and its permission keys with ONE hand-written SQL statement (middleware/auth.ts). The unit
 * tests in this folder have no database: they describe their users through a stubbed `prisma.user.findUnique` that returns the user with
 * `role.permissions[].permission.key`. This points the middleware at that same stub and reshapes the answer, so every one of those tests
 * still exercises the real checks (inactive, tokenVersion, forced password change, permissions) over the users it already defines.
 * The real SQL itself is covered against a real database in test/db/authQuery.db.test.ts.
 */
export async function useUserModelForAuth(prisma: any): Promise<void> {
  const { authLookup } = await import("../../src/middleware/auth");
  authLookup.load = async (userId: string) => {
    const u = await prisma.user.findUnique({ where: { id: userId } });
    if (!u) return null;
    return {
      id: u.id,
      isActive: u.isActive,
      tokenVersion: u.tokenVersion,
      mustChangePassword: u.mustChangePassword,
      customerId: u.customerId ?? null,
      vendorId: u.vendorId ?? null,
      roleKey: u.role.key,
      permissions: (u.role.permissions ?? []).map((rp: any) => rp.permission.key),
    };
  };
}
