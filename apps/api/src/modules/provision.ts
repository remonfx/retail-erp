import { uuidv7, ROLE_TEMPLATES } from '@rc/domain';
import type { Tx } from '../lib/db.js';
import { COA_TEMPLATE, MAPPING_TEMPLATE, JOURNALS, UOM_TEMPLATE, TAX_TEMPLATE, REASON_TEMPLATE } from './templates.js';

/** Tenant-level master data: roles, UoM, taxes, root category, reason codes, scale barcode rules. */
export async function provisionTenantMasters(tx: Tx, tenantId: string): Promise<{ roles: Record<string, string> }> {
  const roles: Record<string, string> = {};
  for (const [code, r] of Object.entries(ROLE_TEMPLATES)) {
    const id = uuidv7();
    roles[code] = id;
    await tx.query('INSERT INTO core_role (id, tenant_id, code, name_ar, name_en, is_system) VALUES ($1,$2,$3,$4,$5,true)', [id, tenantId, code, r.nameAr, r.nameEn]);
    await tx.query(`INSERT INTO core_role_permission (tenant_id, role_id, permission) SELECT $1, $2, unnest($3::text[])`, [tenantId, id, [...new Set(r.permissions)]]);
  }
  for (const c of UOM_TEMPLATE) {
    const cid = uuidv7();
    await tx.query('INSERT INTO cat_uom_category (id, tenant_id, code, name_ar, name_en) VALUES ($1,$2,$3,$4,$5)', [cid, tenantId, c.cat, c.catAr, c.catEn]);
    for (const u of c.items) await tx.query('INSERT INTO cat_uom (id, tenant_id, category_id, code, name_ar, name_en, factor, rounding) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [uuidv7(), tenantId, cid, u.code, u.ar, u.en, u.factor, u.rounding]);
  }
  const rateIds: Record<string, string> = {};
  for (const r of TAX_TEMPLATE.rates) {
    rateIds[r.code] = uuidv7();
    await tx.query('INSERT INTO tax_rate (id, tenant_id, code, name_ar, name_en, kind, rate) VALUES ($1,$2,$3,$4,$5,$6,$7)', [rateIds[r.code], tenantId, r.code, r.ar, r.en, r.kind, r.rate]);
  }
  for (const c of TAX_TEMPLATE.classes) {
    const id = uuidv7();
    await tx.query('INSERT INTO tax_class (id, tenant_id, code, name_ar, name_en, eta_tax_type, eta_subtype) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, tenantId, c.code, c.ar, c.en, c.eta, c.etaSub]);
    for (const rc of c.rates) await tx.query('INSERT INTO tax_class_rate (tenant_id, tax_class_id, tax_rate_id) VALUES ($1,$2,$3)', [tenantId, id, rateIds[rc]]);
  }
  const root = uuidv7();
  await tx.query(`INSERT INTO cat_category (id, tenant_id, code, name_ar, name_en, path) VALUES ($1,$2,'ALL','كل المنتجات','All Products',ARRAY[$1]::uuid[])`, [root, tenantId]);
  for (const r of REASON_TEMPLATE) {
    await tx.query('INSERT INTO inv_reason_code (id, tenant_id, code, name_ar, name_en, applies_to, direction, account_mapping_key, requires_approval_above) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [uuidv7(), tenantId, r.code, r.ar, r.en, r.applies, r.dir, r.key, r.limit]);
  }
  await tx.query(`INSERT INTO cat_embedded_barcode_rule (id, tenant_id, prefix, item_code_length, value_length, value_type, value_decimals) VALUES ($1,$2,'21',5,5,'weight',3), ($3,$2,'22',5,5,'price',2)`, [uuidv7(), tenantId, uuidv7()]);
  return { roles };
}

export interface CompanyInput { code: string; legalNameAr: string; legalNameEn?: string | null; taxRegistrationNo?: string | null; costingMethod?: 'average' | 'fifo' }

export async function provisionCompany(tx: Tx, tenantId: string, userId: string, input: CompanyInput, now = new Date()): Promise<{ companyId: string; priceListId: string }> {
  const companyId = uuidv7();
  await tx.query(`INSERT INTO core_company (id, tenant_id, code, legal_name_ar, legal_name_en, tax_registration_no, costing_method, created_by, settings)
                  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [companyId, tenantId, input.code, input.legalNameAr, input.legalNameEn ?? null, input.taxRegistrationNo ?? null, input.costingMethod ?? 'average', userId,
     JSON.stringify({ poApprovalThreshold: '0', priceTolerancePercent: '0.5', overReceiptPercent: '0', expenseApprovalThreshold: '0', paymentApprovalThreshold: '0' })]);
  // company-level virtual locations
  for (const [code, type, ar, en] of [['SUPPLIERS', 'supplier', 'الموردون', 'Suppliers'], ['CUSTOMERS', 'customer', 'العملاء', 'Customers'], ['LOSS', 'inventory_loss', 'فروقات المخزون', 'Inventory Loss'], ['TRANSIT', 'transit', 'بضاعة بالطريق', 'In Transit']] as const) {
    const id = uuidv7();
    await tx.query('INSERT INTO inv_location (id, tenant_id, company_id, code, name_ar, name_en, type, path) VALUES ($1,$2,$3,$4,$5,$6,$7,$4)', [id, tenantId, companyId, code, ar, en, type]);
  }
  // chart of accounts
  const ids: Record<string, string> = {};
  for (const a of COA_TEMPLATE) {
    ids[a.code] = uuidv7();
    const parent = a.group ? null : ids[a.code[0]!];
    await tx.query(`INSERT INTO acc_account (id, tenant_id, company_id, code, name_ar, name_en, type, subtype, cash_flow_group, parent_id, is_postable, reconcilable)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [ids[a.code], tenantId, companyId, a.code, a.ar, a.en, a.type, a.subtype, a.cf, parent, !a.group, !!a.reconcilable]);
  }
  for (const [key, code] of Object.entries(MAPPING_TEMPLATE)) {
    await tx.query('INSERT INTO acc_account_mapping (id, tenant_id, company_id, key, account_id) VALUES ($1,$2,$3,$4,$5)', [uuidv7(), tenantId, companyId, key, ids[code]]);
  }
  for (const j of JOURNALS) await tx.query('INSERT INTO acc_journal (id, tenant_id, company_id, code, name_ar, name_en, kind) VALUES ($1,$2,$3,$4,$5,$6,$7)', [uuidv7(), tenantId, companyId, j.code, j.ar, j.en, j.kind]);
  const year = now.getUTCFullYear();
  for (const y of [year - 1, year, year + 1]) await createFiscalYear(tx, tenantId, companyId, y);
  await tx.query(`INSERT INTO acc_bank_account (id, tenant_id, company_id, name_ar, name_en, account_id, kind) VALUES ($1,$2,$3,'الخزينة الرئيسية','Main Safe',$4,'safe'), ($5,$2,$3,'البنك - الحساب الجاري','Bank - Current',$6,'bank')`,
    [uuidv7(), tenantId, companyId, ids['1102'], uuidv7(), ids['1111']]);
  const priceListId = uuidv7();
  await tx.query(`INSERT INTO prc_price_list (id, tenant_id, company_id, code, name_ar, name_en, kind, scope, priority) VALUES ($1,$2,$3,'RETAIL','قائمة أسعار التجزئة','Retail Price List','retail','company',100)`, [priceListId, tenantId, companyId]);
  return { companyId, priceListId };
}

export async function createFiscalYear(tx: Tx, tenantId: string, companyId: string, year: number) {
  const fy = uuidv7();
  await tx.query(`INSERT INTO acc_fiscal_year (id, tenant_id, company_id, code, start_date, end_date) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [fy, tenantId, companyId, `FY${year}`, `${year}-01-01`, `${year}-12-31`]);
  for (let m = 1; m <= 12; m++) {
    const start = `${year}-${String(m).padStart(2, '0')}-01`;
    const end = new Date(Date.UTC(year, m, 0)).toISOString().slice(0, 10);
    await tx.query(`INSERT INTO acc_fiscal_period (id, tenant_id, company_id, fiscal_year_id, code, start_date, end_date) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [uuidv7(), tenantId, companyId, fy, `${year}-${String(m).padStart(2, '0')}`, start, end]);
  }
}

export interface BranchInput { code: string; nameAr: string; nameEn?: string | null; timezone?: string; address?: string | null; phone?: string | null }

export async function provisionBranch(tx: Tx, tenantId: string, companyId: string, userId: string, b: BranchInput) {
  const branchId = uuidv7(), warehouseId = uuidv7();
  await tx.query(`INSERT INTO core_branch (id, tenant_id, company_id, code, name_ar, name_en, timezone, address, phone, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [branchId, tenantId, companyId, b.code, b.nameAr, b.nameEn ?? null, b.timezone ?? 'Africa/Cairo', b.address ?? null, b.phone ?? null, userId]);
  await tx.query(`INSERT INTO core_cost_center (id, tenant_id, company_id, code, name_ar, name_en, branch_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [uuidv7(), tenantId, companyId, `CC-${b.code}`, `مركز تكلفة ${b.nameAr}`, b.nameEn ? `${b.nameEn} cost center` : null, branchId]);
  await tx.query(`INSERT INTO core_warehouse (id, tenant_id, company_id, branch_id, code, name_ar, name_en, kind) VALUES ($1,$2,$3,$4,$5,$6,$7,'store')`, [warehouseId, tenantId, companyId, branchId, `${b.code}-WH`, `مخزن ${b.nameAr}`, b.nameEn ? `${b.nameEn} Warehouse` : null]);
  const loc: Record<string, string> = {};
  for (const [suffix, type, ar, en] of [['STOCK', 'internal', 'المخزون', 'Stock'], ['QUAR', 'quarantine', 'حجر/مرتجعات', 'Quarantine'], ['SCRAP', 'scrap', 'هالك', 'Scrap']] as const) {
    loc[type] = uuidv7();
    await tx.query(`INSERT INTO inv_location (id, tenant_id, company_id, warehouse_id, branch_id, code, name_ar, name_en, type, path) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$6)`,
      [loc[type], tenantId, companyId, warehouseId, branchId, `${b.code}-${suffix}`, ar, en, type]);
  }
  return { branchId, warehouseId, stockLocationId: loc.internal!, quarantineLocationId: loc.quarantine!, scrapLocationId: loc.scrap! };
}
