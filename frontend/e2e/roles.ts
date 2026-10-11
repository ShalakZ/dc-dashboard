// The sidebar writes the role out under the user's name (Layout.tsx ROLE_LABEL); the specs assert the same words.
const LABELS: Record<string, string> = { admin: "Administrator", operator: "Operator", viewer: "Viewer" };
export const roleLabel = (role: string): string => LABELS[role] ?? role;
