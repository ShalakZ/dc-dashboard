// The top bar writes the role out under the user's name (BUILTIN_ROLE_LABELS and roleLabel in components/navItems.ts); the specs assert the same words.
const LABELS: Record<string, string> = { admin: "Administrator", operator: "Operator", viewer: "Viewer" };
export const roleLabel = (role: string): string => LABELS[role] ?? role;
