/**
 * Provisioning templates for a new SaaS tenant/company.
 * Chart of accounts: simplified Egyptian retail template (to be reviewed by the customer's accountant).
 * Tax defaults: VAT 14% standard (Law 67/2016) — MUST be validated against current ETA rules per customer.
 */
export interface AccountTpl { code: string; ar: string; en: string; type: 'asset' | 'liability' | 'equity' | 'income' | 'expense'; subtype: string; cf: 'cash' | 'operating' | 'investing' | 'financing' | 'non_cash'; group?: boolean; reconcilable?: boolean }

export const COA_TEMPLATE: AccountTpl[] = [
  { code: '1', ar: 'الأصول', en: 'Assets', type: 'asset', subtype: 'view', cf: 'non_cash', group: true },
  { code: '1101', ar: 'نقدية خزائن نقاط البيع', en: 'POS Cash', type: 'asset', subtype: 'cash', cf: 'cash' },
  { code: '1102', ar: 'الخزينة الرئيسية', en: 'Main Safe', type: 'asset', subtype: 'cash', cf: 'cash' },
  { code: '1103', ar: 'نقدية بالطريق', en: 'Cash in Transit', type: 'asset', subtype: 'cash', cf: 'cash' },
  { code: '1111', ar: 'البنك - الحساب الجاري', en: 'Bank - Current Account', type: 'asset', subtype: 'bank', cf: 'cash', reconcilable: true },
  { code: '1121', ar: 'تسويات بطاقات الدفع', en: 'Card Clearing', type: 'asset', subtype: 'clearing', cf: 'operating', reconcilable: true },
  { code: '1122', ar: 'تسويات المحافظ وإنستاباي', en: 'Wallet / InstaPay Clearing', type: 'asset', subtype: 'clearing', cf: 'operating', reconcilable: true },
  { code: '1123', ar: 'تسويات شركات التقسيط', en: 'BNPL Clearing', type: 'asset', subtype: 'clearing', cf: 'operating', reconcilable: true },
  { code: '1131', ar: 'العملاء', en: 'Accounts Receivable', type: 'asset', subtype: 'receivable', cf: 'operating', reconcilable: true },
  { code: '1141', ar: 'المخزون', en: 'Inventory', type: 'asset', subtype: 'inventory', cf: 'operating' },
  { code: '1142', ar: 'مخزون بالطريق (تحويلات)', en: 'Inventory in Transit', type: 'asset', subtype: 'inventory', cf: 'operating' },
  { code: '1151', ar: 'ضريبة القيمة المضافة - مدخلات', en: 'VAT Input Recoverable', type: 'asset', subtype: 'tax_input', cf: 'operating' },
  { code: '1152', ar: 'ضريبة الخصم من المنبع - مدينة', en: 'WHT Receivable', type: 'asset', subtype: 'tax_input', cf: 'operating' },
  { code: '1161', ar: 'إشعارات مدينة للموردين', en: 'Supplier Debit Notes Receivable', type: 'asset', subtype: 'receivable', cf: 'operating' },
  { code: '1171', ar: 'سلف العاملين', en: 'Employee Advances', type: 'asset', subtype: 'receivable', cf: 'operating' },
  { code: '1201', ar: 'الأصول الثابتة', en: 'Fixed Assets', type: 'asset', subtype: 'fixed_asset', cf: 'investing' },
  { code: '1202', ar: 'مجمع الإهلاك', en: 'Accumulated Depreciation', type: 'asset', subtype: 'fixed_asset', cf: 'non_cash' },
  { code: '2', ar: 'الالتزامات', en: 'Liabilities', type: 'liability', subtype: 'view', cf: 'non_cash', group: true },
  { code: '2101', ar: 'الموردون', en: 'Accounts Payable', type: 'liability', subtype: 'payable', cf: 'operating', reconcilable: true },
  { code: '2102', ar: 'بضاعة مستلمة لم تُفوتر', en: 'Goods Received Not Invoiced', type: 'liability', subtype: 'grni', cf: 'operating', reconcilable: true },
  { code: '2111', ar: 'ضريبة القيمة المضافة - مخرجات', en: 'VAT Output Payable', type: 'liability', subtype: 'tax_output', cf: 'operating' },
  { code: '2112', ar: 'ضريبة الخصم من المنبع - دائنة', en: 'WHT Payable', type: 'liability', subtype: 'tax_output', cf: 'operating' },
  { code: '2121', ar: 'رواتب مستحقة', en: 'Salaries Payable', type: 'liability', subtype: 'payable', cf: 'operating' },
  { code: '2122', ar: 'تأمينات اجتماعية مستحقة', en: 'Social Insurance Payable', type: 'liability', subtype: 'payable', cf: 'operating' },
  { code: '2123', ar: 'ضريبة كسب العمل مستحقة', en: 'Payroll Tax Payable', type: 'liability', subtype: 'payable', cf: 'operating' },
  { code: '2131', ar: 'التزامات كروت الهدايا ورصيد العملاء', en: 'Gift Card & Store Credit Liability', type: 'liability', subtype: 'deferred', cf: 'operating' },
  { code: '2141', ar: 'تأمينات ودفعات مقدمة من العملاء', en: 'Customer Deposits', type: 'liability', subtype: 'deferred', cf: 'operating' },
  { code: '2201', ar: 'قروض طويلة الأجل', en: 'Long-term Loans', type: 'liability', subtype: 'loan', cf: 'financing' },
  { code: '3', ar: 'حقوق الملكية', en: 'Equity', type: 'equity', subtype: 'view', cf: 'non_cash', group: true },
  { code: '3101', ar: 'رأس المال', en: 'Share Capital', type: 'equity', subtype: 'capital', cf: 'financing' },
  { code: '3201', ar: 'أرباح مرحلة', en: 'Retained Earnings', type: 'equity', subtype: 'retained', cf: 'non_cash' },
  { code: '3901', ar: 'أرصدة افتتاحية', en: 'Opening Balance Equity', type: 'equity', subtype: 'opening', cf: 'non_cash' },
  { code: '4', ar: 'الإيرادات', en: 'Revenue', type: 'income', subtype: 'view', cf: 'non_cash', group: true },
  { code: '4101', ar: 'إيرادات المبيعات', en: 'Sales Revenue', type: 'income', subtype: 'revenue', cf: 'operating' },
  { code: '4102', ar: 'خصومات المبيعات', en: 'Sales Discounts', type: 'income', subtype: 'contra_revenue', cf: 'operating' },
  { code: '4103', ar: 'مردودات المبيعات', en: 'Sales Returns', type: 'income', subtype: 'contra_revenue', cf: 'operating' },
  { code: '4201', ar: 'إيرادات أخرى', en: 'Other Income', type: 'income', subtype: 'other_income', cf: 'operating' },
  { code: '4202', ar: 'أرباح فروق جرد', en: 'Inventory Count Gain', type: 'income', subtype: 'other_income', cf: 'operating' },
  { code: '4203', ar: 'زيادة نقدية', en: 'Cash Over', type: 'income', subtype: 'other_income', cf: 'operating' },
  { code: '5', ar: 'المصروفات', en: 'Expenses', type: 'expense', subtype: 'view', cf: 'non_cash', group: true },
  { code: '5101', ar: 'تكلفة البضاعة المباعة', en: 'Cost of Goods Sold', type: 'expense', subtype: 'cogs', cf: 'operating' },
  { code: '5102', ar: 'فروق أسعار الشراء', en: 'Purchase Price Variance', type: 'expense', subtype: 'cogs', cf: 'operating' },
  { code: '5201', ar: 'عجز المخزون', en: 'Inventory Shrinkage', type: 'expense', subtype: 'inventory_loss', cf: 'operating' },
  { code: '5202', ar: 'بضاعة تالفة', en: 'Damaged Goods', type: 'expense', subtype: 'inventory_loss', cf: 'operating' },
  { code: '5203', ar: 'بضاعة منتهية الصلاحية', en: 'Expired Goods', type: 'expense', subtype: 'inventory_loss', cf: 'operating' },
  { code: '5204', ar: 'فاقد تحويلات', en: 'Transit Loss', type: 'expense', subtype: 'inventory_loss', cf: 'operating' },
  { code: '5301', ar: 'الأجور والرواتب', en: 'Salaries & Wages', type: 'expense', subtype: 'payroll', cf: 'operating' },
  { code: '5302', ar: 'حصة الشركة في التأمينات', en: 'Employer Social Insurance', type: 'expense', subtype: 'payroll', cf: 'operating' },
  { code: '5401', ar: 'الإيجارات', en: 'Rent', type: 'expense', subtype: 'opex', cf: 'operating' },
  { code: '5402', ar: 'كهرباء ومياه', en: 'Utilities', type: 'expense', subtype: 'opex', cf: 'operating' },
  { code: '5403', ar: 'عمولات بطاقات الدفع', en: 'Card Processing Fees', type: 'expense', subtype: 'opex', cf: 'operating' },
  { code: '5404', ar: 'عجز نقدية', en: 'Cash Short', type: 'expense', subtype: 'opex', cf: 'operating' },
  { code: '5405', ar: 'فروق تقريب', en: 'Rounding Differences', type: 'expense', subtype: 'opex', cf: 'operating' },
  { code: '5406', ar: 'دعاية وإعلان', en: 'Marketing', type: 'expense', subtype: 'opex', cf: 'operating' },
  { code: '5407', ar: 'الإهلاك', en: 'Depreciation', type: 'expense', subtype: 'opex', cf: 'non_cash' },
  { code: '5499', ar: 'مصروفات تشغيل أخرى', en: 'Other Operating Expenses', type: 'expense', subtype: 'opex', cf: 'operating' },
];

/** Account mapping keys → account code (company defaults; overridable per branch/category/tender/tax/reason). */
export const MAPPING_TEMPLATE: Record<string, string> = {
  'sales.revenue': '4101', 'sales.discount': '4102', 'sales.returns': '4103',
  'tax.vat_output': '2111', 'tax.vat_input': '1151', 'tax.wht_payable': '2112', 'tax.wht_receivable': '1152',
  'inventory.asset': '1141', 'inventory.in_transit': '1142', 'inventory.cogs': '5101',
  'inventory.shrinkage': '5201', 'inventory.damage': '5202', 'inventory.expired': '5203', 'inventory.transit_loss': '5204', 'inventory.count_gain': '4202',
  'purchase.grni': '2102', 'purchase.price_variance': '5102', 'ap.trade': '2101', 'ap.debit_note': '1161', 'ar.trade': '1131',
  'pos.cash': '1101', 'pos.card_clearing': '1121', 'pos.wallet_clearing': '1122', 'pos.bnpl_clearing': '1123',
  'pos.store_credit': '2131', 'pos.voucher': '2131', 'pos.customer_account': '1131',
  'pos.cash_over': '4203', 'pos.cash_short': '5404', 'pos.rounding': '5405', 'pos.safe': '1102',
  'bank.card_fees': '5403',
  'payroll.salaries': '5301', 'payroll.employer_si': '5302', 'payroll.salaries_payable': '2121', 'payroll.si_payable': '2122', 'payroll.tax_payable': '2123', 'payroll.advances': '1171',
  'equity.retained': '3201', 'equity.opening': '3901',
};

export const TENDER_MAPPING_KEY: Record<string, string> = {
  cash: 'pos.cash', card: 'pos.card_clearing', wallet: 'pos.wallet_clearing', instapay: 'pos.wallet_clearing',
  bnpl: 'pos.bnpl_clearing', voucher: 'pos.voucher', store_credit: 'pos.store_credit', customer_account: 'pos.customer_account',
};

export const JOURNALS = [
  { code: 'SAL', ar: 'يومية المبيعات', en: 'Sales Journal', kind: 'sales' },
  { code: 'PUR', ar: 'يومية المشتريات', en: 'Purchases Journal', kind: 'purchase' },
  { code: 'INV', ar: 'يومية المخزون', en: 'Inventory Journal', kind: 'inventory' },
  { code: 'BNK', ar: 'يومية البنك والخزينة', en: 'Bank & Cash Journal', kind: 'bank' },
  { code: 'GEN', ar: 'اليومية العامة', en: 'General Journal', kind: 'general' },
  { code: 'PAY', ar: 'يومية الرواتب', en: 'Payroll Journal', kind: 'payroll' },
  { code: 'CLS', ar: 'يومية الإقفال', en: 'Closing Journal', kind: 'closing' },
] as const;

export const UOM_TEMPLATE = [
  { cat: 'UNIT', catAr: 'وحدات', catEn: 'Units', items: [{ code: 'PCS', ar: 'قطعة', en: 'Piece', factor: '1', rounding: '1' }, { code: 'DZN', ar: 'دستة', en: 'Dozen', factor: '12', rounding: '1' }] },
  { cat: 'WEIGHT', catAr: 'أوزان', catEn: 'Weight', items: [{ code: 'KG', ar: 'كيلوجرام', en: 'Kilogram', factor: '1', rounding: '0.001' }, { code: 'G', ar: 'جرام', en: 'Gram', factor: '0.001', rounding: '1' }] },
  { cat: 'VOLUME', catAr: 'أحجام', catEn: 'Volume', items: [{ code: 'L', ar: 'لتر', en: 'Liter', factor: '1', rounding: '0.001' }, { code: 'ML', ar: 'مللي', en: 'Milliliter', factor: '0.001', rounding: '1' }] },
  { cat: 'LENGTH', catAr: 'أطوال', catEn: 'Length', items: [{ code: 'M', ar: 'متر', en: 'Meter', factor: '1', rounding: '0.01' }, { code: 'CM', ar: 'سنتيمتر', en: 'Centimeter', factor: '0.01', rounding: '1' }] },
];

export const TAX_TEMPLATE = {
  rates: [
    { code: 'VAT14', ar: 'ضريبة القيمة المضافة 14%', en: 'VAT 14%', kind: 'vat', rate: '14' },
    { code: 'VAT0', ar: 'ضريبة بسعر صفر', en: 'VAT 0%', kind: 'zero', rate: '0' },
    { code: 'EXEMPT', ar: 'معفى', en: 'Exempt', kind: 'exempt', rate: '0' },
  ],
  classes: [
    { code: 'STANDARD', ar: 'خاضع للضريبة العامة', en: 'Standard rated', rates: ['VAT14'], eta: 'T1', etaSub: 'V009' },
    { code: 'ZERO', ar: 'سعر صفر', en: 'Zero rated', rates: ['VAT0'], eta: 'T1', etaSub: 'V001' },
    { code: 'EXEMPT', ar: 'معفى', en: 'Exempt', rates: [], eta: 'T1', etaSub: 'V003' },
  ],
};

export const REASON_TEMPLATE = [
  { code: 'SHRINK', ar: 'عجز جرد/سرقة', en: 'Shrinkage', applies: 'adjustment', dir: 'out', key: 'inventory.shrinkage', limit: '5000' },
  { code: 'DAMAGE', ar: 'تالف', en: 'Damaged', applies: 'scrap', dir: 'out', key: 'inventory.damage', limit: '5000' },
  { code: 'EXPIRED', ar: 'منتهي الصلاحية', en: 'Expired', applies: 'scrap', dir: 'out', key: 'inventory.expired', limit: '5000' },
  { code: 'FOUND', ar: 'زيادة جرد', en: 'Found / Gain', applies: 'adjustment', dir: 'in', key: 'inventory.count_gain', limit: '5000' },
  { code: 'COUNT', ar: 'فروق جرد دوري', en: 'Stock count variance', applies: 'count', dir: 'both', key: 'inventory.shrinkage', limit: '10000' },
  { code: 'TRANSIT', ar: 'فاقد تحويل', en: 'Transit loss', applies: 'transfer', dir: 'out', key: 'inventory.transit_loss', limit: '5000' },
  { code: 'OPENING', ar: 'رصيد افتتاحي', en: 'Opening balance', applies: 'adjustment', dir: 'in', key: 'equity.opening', limit: null },
] as const;
