/** CSV-Zelle: Anführungszeichen maskieren und Formel-Injektion (=, +, -, @) entschärfen. */
export const csvCell = (v: unknown) => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
