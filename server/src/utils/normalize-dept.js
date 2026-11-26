/**
 * Utility functions for normalizing department names and codes.
 * Extracted from models/department.model.js for SQL Server migration (no Mongoose dependency).
 */

export function normalizeDeptName(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/đ/g, 'd')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeDeptCode(code) {
  return String(code ?? '')
    .trim()
    .toUpperCase()
    .replace(/Đ/g, 'D')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^A-Z0-9]/g, '');
}

export function findDeptInSnapshot(snapshot, { name, code } = {}) {
  if (name) {
    const key = normalizeDeptName(name);
    return snapshot.find((d) => normalizeDeptName(d.name) === key) ?? null;
  }
  if (code) {
    const key = normalizeDeptCode(code);
    return snapshot.find((d) => d.code && normalizeDeptCode(d.code) === key) ?? null;
  }
  return null;
}
