/**
 * Permission catalog & system role templates (SECURITY.md §3). Shared by API (enforcement)
 * and clients (UI hiding only — never the control).
 */
export const PERMISSIONS = [
  // core / admin
  'core.org.read', 'core.org.manage',
  'core.user.read', 'core.user.manage',
  'core.role.manage',
  'core.device.manage',
  'core.audit.read',
  'core.settings.manage',
  'saas.subscription.manage',
  // catalog
  'catalog.product.read', 'catalog.product.write', 'catalog.product.merge', 'catalog.product.import',
  'catalog.cost.view',
  // pricing
  'pricing.pricelist.read', 'pricing.pricelist.write', 'pricing.price.approve',
  'pricing.promotion.read', 'pricing.promotion.write', 'pricing.promotion.approve',
  // inventory
  'inventory.stock.read',
  'inventory.receipt.write', 'inventory.transfer.write', 'inventory.transfer.approve',
  'inventory.adjustment.write', 'inventory.adjustment.approve',
  'inventory.count.write', 'inventory.count.approve',
  // purchasing
  'purchasing.supplier.read', 'purchasing.supplier.write',
  'purchasing.request.write', 'purchasing.order.write', 'purchasing.order.approve',
  'purchasing.invoice.write', 'purchasing.invoice.approve',
  // sales / pos
  'pos.sell', 'pos.discount.override', 'pos.void', 'pos.refund', 'pos.refund.no_receipt',
  'pos.session.open', 'pos.session.close', 'pos.session.approve',
  'pos.sync.monitor',
  'sales.order.read', 'sales.customer.read', 'sales.customer.write',
  // accounting
  'accounting.read', 'accounting.journal.write', 'accounting.journal.post', 'accounting.journal.reverse',
  'accounting.coa.manage', 'accounting.posting_rules.manage', 'accounting.period.manage', 'accounting.post_locked_period',
  'accounting.payment.write', 'accounting.payment.approve',
  'accounting.expense.write', 'accounting.expense.approve',
  'accounting.reports.read',
  // reporting / hr
  'reporting.dashboard.read', 'reporting.export',
  'hr.employee.read', 'hr.employee.write', 'hr.attendance.write', 'hr.payroll.import',
  // workflow
  'workflow.approval.decide',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const R = (prefixes: string[], extra: Permission[] = [], exclude: Permission[] = []): Permission[] => {
  const set = new Set<Permission>(PERMISSIONS.filter((p) => prefixes.some((x) => p === x || p.startsWith(x + '.') || (x.endsWith('*') && p.startsWith(x.slice(0, -1))))));
  extra.forEach((p) => set.add(p));
  exclude.forEach((p) => set.delete(p));
  return [...set];
};

const READS: Permission[] = PERMISSIONS.filter((p) => p.endsWith('.read'));

export const ROLE_TEMPLATES: Record<string, { nameAr: string; nameEn: string; permissions: Permission[] }> = {
  tenant_owner: {
    nameAr: 'مالك الحساب', nameEn: 'Tenant Owner',
    // Owner can operate the whole tenant, but SoD-sensitive rights are delegated:
    // journal posting & payment approval go to finance roles; user/role admin comes via system_admin.
    permissions: PERMISSIONS.filter((p) => !['accounting.journal.post', 'accounting.post_locked_period', 'accounting.payment.approve', 'core.role.manage', 'core.user.manage'].includes(p)),
  },
  system_admin: {
    nameAr: 'مدير النظام', nameEn: 'System Administrator',
    permissions: ['core.org.read', 'core.org.manage', 'core.user.read', 'core.user.manage', 'core.role.manage', 'core.device.manage', 'core.settings.manage', 'core.audit.read', 'pos.sync.monitor'],
  },
  financial_controller: {
    nameAr: 'المراقب المالي', nameEn: 'Financial Controller',
    permissions: R(['accounting'], ['catalog.product.read', 'catalog.cost.view', 'inventory.stock.read', 'purchasing.supplier.read', 'purchasing.invoice.approve', 'sales.order.read',
      'reporting.dashboard.read', 'reporting.export', 'workflow.approval.decide', 'core.audit.read', 'core.org.read', 'pos.session.approve']),
  },
  accountant: {
    nameAr: 'محاسب', nameEn: 'Accountant',
    permissions: ['accounting.read', 'accounting.journal.write', 'accounting.payment.write', 'accounting.expense.write', 'accounting.reports.read',
      'purchasing.invoice.write', 'purchasing.supplier.read', 'catalog.product.read', 'catalog.cost.view', 'inventory.stock.read', 'sales.order.read', 'core.org.read'],
  },
  branch_manager: {
    nameAr: 'مدير فرع', nameEn: 'Branch Manager',
    permissions: ['core.org.read', 'core.user.read', 'catalog.product.read', 'catalog.cost.view', 'pricing.pricelist.read', 'pricing.promotion.read', 'inventory.stock.read',
      'inventory.transfer.write', 'inventory.transfer.approve', 'inventory.adjustment.approve', 'inventory.count.approve', 'purchasing.request.write',
      'pos.sell', 'pos.discount.override', 'pos.void', 'pos.refund', 'pos.refund.no_receipt', 'pos.session.open', 'pos.session.close', 'pos.session.approve', 'pos.sync.monitor',
      'sales.order.read', 'sales.customer.read', 'sales.customer.write', 'accounting.expense.write', 'reporting.dashboard.read', 'workflow.approval.decide', 'hr.employee.read'],
  },
  shift_supervisor: {
    nameAr: 'مشرف وردية', nameEn: 'Shift Supervisor',
    permissions: ['catalog.product.read', 'inventory.stock.read', 'pos.sell', 'pos.discount.override', 'pos.void', 'pos.refund', 'pos.session.open', 'pos.session.close', 'sales.order.read', 'sales.customer.read', 'sales.customer.write'],
  },
  cashier: {
    nameAr: 'كاشير', nameEn: 'Cashier',
    permissions: ['catalog.product.read', 'inventory.stock.read', 'pos.sell', 'pos.session.open', 'pos.session.close', 'sales.customer.read', 'sales.customer.write'],
  },
  inventory_manager: {
    nameAr: 'مدير مخزون', nameEn: 'Inventory Manager',
    permissions: R(['inventory'], ['catalog.product.read', 'catalog.product.write', 'catalog.product.import', 'catalog.cost.view', 'purchasing.request.write', 'purchasing.supplier.read', 'reporting.dashboard.read', 'reporting.export', 'workflow.approval.decide', 'core.org.read']),
  },
  warehouse_clerk: {
    nameAr: 'أمين مخزن', nameEn: 'Warehouse Clerk',
    permissions: ['catalog.product.read', 'inventory.stock.read', 'inventory.receipt.write', 'inventory.transfer.write', 'inventory.adjustment.write', 'inventory.count.write', 'core.org.read'],
  },
  purchasing_manager: {
    nameAr: 'مدير مشتريات', nameEn: 'Purchasing Manager',
    permissions: R(['purchasing'], ['catalog.product.read', 'catalog.product.write', 'catalog.cost.view', 'pricing.pricelist.read', 'pricing.pricelist.write', 'pricing.promotion.read', 'pricing.promotion.write',
      'inventory.stock.read', 'reporting.dashboard.read', 'reporting.export', 'workflow.approval.decide', 'core.org.read']),
  },
  buyer: {
    nameAr: 'مشتري', nameEn: 'Buyer',
    permissions: ['catalog.product.read', 'catalog.product.write', 'catalog.cost.view', 'pricing.pricelist.read', 'pricing.pricelist.write', 'inventory.stock.read',
      'purchasing.supplier.read', 'purchasing.supplier.write', 'purchasing.request.write', 'purchasing.order.write', 'core.org.read'],
  },
  hr_manager: {
    nameAr: 'مدير موارد بشرية', nameEn: 'HR Manager',
    permissions: ['hr.employee.read', 'hr.employee.write', 'hr.attendance.write', 'hr.payroll.import', 'core.org.read', 'core.user.read'],
  },
  auditor: {
    nameAr: 'مراجع', nameEn: 'Auditor',
    permissions: [...READS, 'accounting.reports.read', 'reporting.dashboard.read', 'core.audit.read', 'catalog.cost.view'],
  },
};

/** Segregation-of-duties conflicts: a single user must not hold both permissions in any scope. */
export const SOD_CONFLICTS: [Permission, Permission][] = [
  ['core.role.manage', 'accounting.journal.post'],
  ['core.user.manage', 'accounting.payment.approve'],
  ['purchasing.supplier.write', 'accounting.payment.approve'],
];

export function sodViolations(perms: Iterable<string>): [Permission, Permission][] {
  const s = new Set(perms);
  return SOD_CONFLICTS.filter(([a, b]) => s.has(a) && s.has(b));
}
