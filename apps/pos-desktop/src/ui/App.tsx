import { useEffect, useMemo, useRef, useState } from 'react';
import { argon2Verify } from 'hash-wasm';
import { dec } from '@rc/domain';
import { PosEngine, PosError, type CartLine, type Tender, type PosUser } from '../core/engine';
import { createStore } from '../core/store';

const verify = (hash: string, pin: string) => argon2Verify({ hash, password: pin }).catch(() => false);
const m2 = (v: unknown) => new Intl.NumberFormat('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(v ?? 0));
const errMsg = (e: unknown) => (e instanceof PosError ? e.message : (e as Error)?.message ?? String(e));

let enginePromise: Promise<PosEngine> | null = null;
const getEngine = () => (enginePromise ??= createStore().then((s) => new PosEngine(s)));

export function App() {
  const [engine, setEngine] = useState<PosEngine | null>(null);
  const [phase, setPhase] = useState<'loading' | 'enroll' | 'login' | 'open' | 'sell'>('loading');
  const [online, setOnline] = useState(true);
  const [sync, setSync] = useState({ pending: 0, quarantined: 0, lastSyncOkAt: null as string | null });
  const [unprinted, setUnprinted] = useState<any[]>([]);

  const route = async (e: PosEngine) => {
    if (!(await e.isEnrolled())) return setPhase('enroll');
    await e.loadIndexes();
    try { await e.refreshConfig(); await e.pullAll(); setOnline(true); } catch { setOnline(false); }
    setUnprinted(await e.unprintedOrders());
    if (!e.cashier) return setPhase('login');
    setPhase((await e.currentSession()) ? 'sell' : 'open');
  };
  useEffect(() => { void getEngine().then(async (e) => { setEngine(e); await route(e); }); }, []);

  // background sync: push every 10s, heartbeat every 60s, master-data deltas every 5 min
  useEffect(() => {
    if (!engine || phase === 'enroll' || phase === 'loading') return;
    let ticks = 0;
    const h = setInterval(async () => {
      ticks++;
      const r = await engine.syncOnce().catch((e) => ({ error: errMsg(e) }));
      setOnline(!('error' in r && r.error));
      if (ticks % 6 === 0) await engine.heartbeat().catch(() => undefined);
      if (ticks % 30 === 0) await engine.pullAll().catch(() => undefined);
      const s = await engine.syncStatus();
      setSync(s);
      if (ticks % 360 === 0) await engine.purgeAcked().catch(() => undefined);
    }, 10_000);
    return () => clearInterval(h);
  }, [engine, phase]);

  if (!engine || phase === 'loading') return <div className="center muted">…</div>;
  if (phase === 'enroll') return <Enroll engine={engine} onDone={() => route(engine)} />;
  if (phase === 'login') return <Login engine={engine} onDone={() => route(engine)} />;
  if (phase === 'open') return <OpenSession engine={engine} onDone={() => setPhase('sell')} onLogout={() => { engine.cashier = null; setPhase('login'); }} />;
  return <Sell engine={engine} online={online} sync={sync} unprinted={unprinted} clearUnprinted={() => setUnprinted([])}
    onClosed={() => setPhase('open')} onLogout={() => { engine.cashier = null; setPhase('login'); }} />;
}

function Enroll({ engine, onDone }: { engine: PosEngine; onDone: () => void }) {
  const [api, setApi] = useState('http://localhost:4000'); const [id, setId] = useState(''); const [code, setCode] = useState('');
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const [progress, setProgress] = useState('');
  const go = async () => {
    setBusy(true); setErr('');
    try { await engine.enroll(api.replace(/\/$/, ''), id.trim(), code.trim().toUpperCase()); await engine.refreshConfig(); await engine.pullAll((s, n) => setProgress(`${s}: +${n}`)); onDone(); }
    catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return <div className="center"><div className="panel">
    <h2 style={{ margin: 0 }}>تفعيل جهاز الكاشير</h2>
    <p className="muted" style={{ margin: 0 }}>من لوحة الإدارة: الإعدادات ← الأجهزة والكاشير ← جهاز جديد</p>
    {err ? <div className="err">{err}</div> : null}
    <label>عنوان الخادم<input dir="ltr" value={api} onChange={(e) => setApi(e.target.value)} /></label>
    <label>Device ID<input dir="ltr" value={id} onChange={(e) => setId(e.target.value)} /></label>
    <label>كود التفعيل<input dir="ltr" value={code} onChange={(e) => setCode(e.target.value)} /></label>
    <button className="primary" disabled={busy || !id || !code} onClick={go}>{busy ? `جاري التحميل… ${progress}` : 'تفعيل وتحميل البيانات'}</button>
  </div></div>;
}

function Login({ engine, onDone }: { engine: PosEngine; onDone: () => void }) {
  const [user, setUser] = useState(''); const [pin, setPin] = useState(''); const [err, setErr] = useState('');
  const cashiers = engine.cashiers();
  const go = async (e: React.FormEvent) => { e.preventDefault(); setErr(''); try { await engine.login(user, pin, verify); onDone(); } catch (x) { setErr(errMsg(x)); setPin(''); } };
  return <div className="center"><form className="panel" onSubmit={go}>
    <h2 style={{ margin: 0 }}>{engine.config?.terminal?.branch_name_ar} — {engine.config?.terminal?.code}</h2>
    {err ? <div className="err">{err}</div> : null}
    <select value={user} onChange={(e) => setUser(e.target.value)} required><option value="">اختر الكاشير</option>{cashiers.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}</select>
    <input type="password" inputMode="numeric" autoComplete="off" placeholder="الرقم السري (6 أرقام)" value={pin} onChange={(e) => setPin(e.target.value)} maxLength={6} required />
    <button className="primary">دخول</button>
    {!cashiers.length ? <p className="muted">لا يوجد كاشير مسموح له بالبيع في هذا الفرع (أو لم يحدد رقمًا سريًا).</p> : null}
  </form></div>;
}

function OpenSession({ engine, onDone, onLogout }: { engine: PosEngine; onDone: () => void; onLogout: () => void }) {
  const [float, setFloat] = useState('500'); const [err, setErr] = useState('');
  return <div className="center"><div className="panel">
    <h2 style={{ margin: 0 }}>فتح وردية — {engine.cashier?.full_name}</h2>
    {err ? <div className="err">{err}</div> : null}
    <label>عهدة أول الوردية (جنيه)<input inputMode="decimal" value={float} onChange={(e) => setFloat(e.target.value)} /></label>
    <button className="primary" onClick={async () => { try { await engine.openSession(dec(float || '0').toFixed(2)); onDone(); } catch (e) { setErr(errMsg(e)); } }}>فتح الوردية</button>
    <button onClick={onLogout}>تغيير الكاشير</button>
  </div></div>;
}

type Mode = { kind: 'sale' } | { kind: 'return'; order: any };

function Sell({ engine, online, sync, unprinted, clearUnprinted, onClosed, onLogout }: { engine: PosEngine; online: boolean; sync: { pending: number; quarantined: number; lastSyncOkAt: string | null }; unprinted: any[]; clearUnprinted: () => void; onClosed: () => void; onLogout: () => void }) {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [sel, setSel] = useState<number>(-1);
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const [mode, setMode] = useState<Mode>({ kind: 'sale' });
  const [pay, setPay] = useState(false);
  const [dialog, setDialog] = useState<'none' | 'x' | 'close' | 'return' | 'cash' | 'override'>('none');
  const [override, setOverride] = useState<PosUser | null>(null);
  const [lastReceipt, setLastReceipt] = useState<any>(null);
  const scanRef = useRef<HTMLInputElement>(null);
  const results = useMemo(() => (q.length >= 2 && !/^\d{8,}$/.test(q) ? engine.search(q, 12) : []), [q, engine]);
  const cart = useMemo(() => { try { return lines.length ? engine.computeCart(lines) : null; } catch (e) { setErr(errMsg(e)); return null; } }, [lines, engine]);
  const focus = () => setTimeout(() => scanRef.current?.focus(), 0);

  const add = (variantId: string, qty = '1') => {
    try {
      setErr('');
      const existing = lines.findIndex((l) => l.variantId === variantId && !l.returnOfLineId && !engine.variant(variantId)?.is_weighted);
      if (existing >= 0) { const next = [...lines]; next[existing] = { ...next[existing]!, qty: dec(next[existing]!.qty).add(dec(qty)).toString() }; setLines(next); setSel(existing); }
      else { setLines([...lines, engine.newLine(variantId, qty)]); setSel(lines.length); }
    } catch (e) { setErr(errMsg(e)); }
    setQ(''); focus();
  };
  const scan = (e: React.FormEvent) => {
    e.preventDefault();
    if (!q.trim()) { if (lines.length) setPay(true); return; }
    const hit = engine.lookup(q);
    if (hit) return add(hit.variant.id, hit.qty);
    if (results[0]) return add(results[0].id);
    setErr(`غير موجود: ${q}`); setQ('');
  };
  const setQty = (i: number, delta: number) => { const l = lines[i]; if (!l) return; const n = dec(l.qty).add(delta); if (n.lte(0)) return remove(i); setLines(lines.map((x, j) => (j === i ? { ...x, qty: n.toString() } : x))); };
  const remove = (i: number) => { setLines(lines.filter((_, j) => j !== i)); setSel(Math.min(i, lines.length - 2)); focus(); };
  const reset = () => { setLines([]); setSel(-1); setMode({ kind: 'sale' }); setOverride(null); focus(); };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (pay || dialog !== 'none') return;
      if (e.key === 'F2') { e.preventDefault(); focus(); }
      else if (e.key === 'F10' || (e.key === 'Enter' && e.ctrlKey)) { e.preventDefault(); if (lines.length) setPay(true); }
      else if (e.key === '+' && sel >= 0) { e.preventDefault(); setQty(sel, 1); }
      else if (e.key === '-' && sel >= 0 && document.activeElement !== scanRef.current) { e.preventDefault(); setQty(sel, -1); }
      else if (e.key === 'Delete' && sel >= 0) { e.preventDefault(); remove(sel); }
      else if (e.key === 'ArrowDown') setSel((s) => Math.min(s + 1, lines.length - 1));
      else if (e.key === 'ArrowUp') setSel((s) => Math.max(s - 1, 0));
      else if (e.key === 'Escape') { setQ(''); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });
  useEffect(() => { focus(); }, []);

  const lastSync = sync.lastSyncOkAt ? new Date(sync.lastSyncOkAt).toLocaleTimeString('ar-EG') : '—';
  return (
    <div className="pos">
      <div className="bar">
        <strong>{engine.config?.terminal?.branch_code} · {engine.config?.terminal?.code}</strong>
        <span>{engine.cashier?.full_name}</span>
        <span className={`pill ${online ? 'ok' : 'bad'}`}>{online ? 'متصل' : 'غير متصل — البيع مستمر'}</span>
        <span className={`pill ${sync.pending ? 'warn' : 'ok'}`}>في الانتظار: {sync.pending}</span>
        {sync.quarantined ? <span className="pill bad">معزول: {sync.quarantined}</span> : null}
        <span className="muted">آخر مزامنة {lastSync}</span>
        {mode.kind === 'return' ? <span className="pill warn">وضع المرتجع — {mode.order.receiptNo}</span> : null}
        <div className="sp" />
        <button onClick={() => setDialog('return')}>مرتجع</button>
        <button onClick={() => setDialog('cash')}>حركة نقدية</button>
        <button onClick={() => setDialog('x')}>تقرير X</button>
        <button onClick={() => setDialog('close')}>إغلاق الوردية</button>
        <button onClick={onLogout}>خروج</button>
      </div>
      {unprinted.length ? <div className="err" style={{ margin: 12 }}>تم استرجاع {unprinted.length} إيصال لم يُطبع بعد انقطاع مفاجئ. <button onClick={() => { setLastReceipt({ ...unprinted[0], reprint: true }); setTimeout(() => { window.print(); void engine.markPrinted(unprinted[0].id); clearUnprinted(); }, 50); }}>إعادة طباعة</button></div> : null}
      <div className="body">
        <div className="cart">
          <form className="scan" onSubmit={scan}>
            <input ref={scanRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="امسح الباركود أو ابحث بالاسم (F2) — Enter فارغ للدفع" aria-label="scan" autoFocus />
            {results.length ? <div className="results">{results.map((v) => <button type="button" key={v.id} onClick={() => add(v.id)}><span>{v.name_ar} {v.name_suffix_ar ?? ''}</span><span className="muted">{v.sku} · {m2(engine.priceFor(v.id, '1')?.price)}</span></button>)}</div> : null}
            {err ? <div className="err" style={{ marginTop: 8 }}>{err}</div> : null}
          </form>
          <div className="lines">
            <table>
              <thead><tr><th>#</th><th>الصنف</th><th className="num">الكمية</th><th className="num">السعر</th><th className="num">الخصم</th><th className="num">الإجمالي</th><th /></tr></thead>
              <tbody>{lines.map((l, i) => {
                const v = engine.variant(l.variantId)!; const r = cart?.lines[i];
                return <tr key={l.lineId} className={i === sel ? 'sel' : ''} onClick={() => setSel(i)}>
                  <td>{i + 1}</td><td>{v.name_ar}<div className="muted" style={{ fontSize: 12 }}>{v.sku}</div></td>
                  <td className="num"><button onClick={() => setQty(i, -1)} aria-label="minus">−</button> {l.qty} <button onClick={() => setQty(i, 1)} aria-label="plus">+</button></td>
                  <td className="num">{m2(l.unitPrice)}</td><td className="num">{r && !r.discountTotal.isZero() ? m2(r.discountTotal.toString()) : ''}</td><td className="num">{r ? m2(r.total.toString()) : ''}</td>
                  <td><button className="danger" onClick={() => remove(i)} aria-label="remove">✕</button></td>
                </tr>;
              })}</tbody>
            </table>
          </div>
        </div>
        <div className="side">
          <div className="totals">
            <div className="row"><span className="muted">قبل الخصم</span><span className="sp" style={{ flex: 1 }} /><span className="num">{m2(cart?.subtotal.toString())}</span></div>
            <div className="row"><span className="muted">الخصومات</span><span style={{ flex: 1 }} /><span className="num">{m2(cart?.discountTotal.toString())}</span></div>
            <div className="row"><span className="muted">ضريبة القيمة المضافة</span><span style={{ flex: 1 }} /><span className="num">{m2(cart?.taxTotal.toString())}</span></div>
            {cart?.promotions.map((p, i) => <div key={i} className="muted" style={{ fontSize: 13 }}>عرض {p.code}: −{m2(p.amount.toString())}</div>)}
            <div className="grand num">{m2(cart?.grandTotal.toString())}</div>
            {cart?.violations.length && !override ? <div className="err">الخصم يتجاوز صلاحيتك — مطلوب موافقة مشرف <button onClick={() => setDialog('override')}>موافقة</button></div> : null}
          </div>
          <div className="keys">
            <button className="primary" disabled={!lines.length || (!!cart?.violations.length && !override)} onClick={() => setPay(true)}>الدفع (F10)</button>
            <button disabled={sel < 0} onClick={() => { const p = prompt('نسبة الخصم على السطر %'); if (p !== null) setLines(lines.map((l, j) => j === sel ? { ...l, manualDiscountPercent: p || null } : l)); }}>خصم على الصنف</button>
            <button disabled={sel < 0} onClick={() => { const n = prompt('الكمية', lines[sel]?.qty); if (n && Number(n) > 0) setLines(lines.map((l, j) => j === sel ? { ...l, qty: n } : l)); }}>تعديل الكمية</button>
            <button className="danger" disabled={!lines.length} onClick={() => confirm('إلغاء الفاتورة؟') && reset()}>إلغاء الفاتورة</button>
          </div>
        </div>
      </div>
      {pay && cart ? <Payment total={cart.grandTotal.toString()} isReturn={mode.kind === 'return'} onCancel={() => { setPay(false); focus(); }} onPay={async (tenders) => {
        try {
          const order = await engine.commit({ lines, tenders, kind: mode.kind, returnOfId: mode.kind === 'return' ? mode.order.id : null, overrideBy: override?.id ?? null, offline: !online });
          setLastReceipt(order); setPay(false); reset();
          setTimeout(() => { window.print(); void engine.markPrinted(order.id); }, 50);
          void engine.syncOnce().catch(() => undefined);
        } catch (e) { setErr(errMsg(e)); setPay(false); }
      }} /> : null}
      {dialog === 'x' ? <XDialog engine={engine} onClose={() => setDialog('none')} /> : null}
      {dialog === 'close' ? <CloseDialog engine={engine} onClose={() => setDialog('none')} onClosed={onClosed} /> : null}
      {dialog === 'cash' ? <CashDialog engine={engine} onClose={() => setDialog('none')} /> : null}
      {dialog === 'override' ? <OverrideDialog engine={engine} onClose={() => setDialog('none')} onOk={(u) => { setOverride(u); setDialog('none'); }} /> : null}
      {dialog === 'return' ? <ReturnDialog engine={engine} onClose={() => setDialog('none')} onStart={(order, ls) => { setMode({ kind: 'return', order }); setLines(ls); setDialog('none'); }} /> : null}
      <Receipt engine={engine} order={lastReceipt} />
    </div>
  );
}

function Payment({ total, isReturn, onPay, onCancel }: { total: string; isReturn: boolean; onPay: (t: Tender[]) => void; onCancel: () => void }) {
  const [cash, setCash] = useState(isReturn ? total : ''); const [card, setCard] = useState(''); const [last4, setLast4] = useState(''); const [appr, setAppr] = useState('');
  const paid = Number(cash || 0) + Number(card || 0); const due = Number(total);
  const change = Math.max(0, paid - due);
  const tenders: Tender[] = [...(Number(card) > 0 ? [{ method: 'card' as const, amount: dec(card).toFixed(2), cardLast4: last4 || undefined, approvalCode: appr || undefined }] : []), ...(Number(cash) > 0 ? [{ method: 'cash' as const, amount: dec(cash).toFixed(2) }] : [])];
  return <div className="modal-bg"><div className="modal" onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }}>
    <h2 style={{ margin: 0 }}>{isReturn ? 'رد المبلغ' : 'الدفع'} — {m2(total)}</h2>
    <label>نقدي<input autoFocus inputMode="decimal" value={cash} onChange={(e) => setCash(e.target.value)} /></label>
    <div className="row">{[50, 100, 200, 500].map((n) => <button key={n} type="button" onClick={() => setCash(String(Math.ceil(due / n) * n))}>{n}</button>)}<button type="button" onClick={() => { setCash(total); setCard(''); }}>المبلغ بالضبط</button></div>
    <label>بطاقة (من ماكينة البنك)<input inputMode="decimal" value={card} onChange={(e) => setCard(e.target.value)} /></label>
    {Number(card) > 0 ? <div className="row"><input placeholder="آخر 4 أرقام" maxLength={4} value={last4} onChange={(e) => setLast4(e.target.value)} /><input placeholder="رقم الموافقة" value={appr} onChange={(e) => setAppr(e.target.value)} /></div> : null}
    <div className="row"><strong>المدفوع {m2(paid)}</strong><span style={{ flex: 1 }} /><strong>الباقي {m2(change)}</strong></div>
    {Number(card) > due ? <div className="err">مبلغ البطاقة أكبر من الإجمالي</div> : null}
    <div className="row"><button className="primary" disabled={paid < due || Number(card) > due} onClick={() => onPay(tenders)}>تأكيد وطباعة</button><button onClick={onCancel}>رجوع</button></div>
  </div></div>;
}

function XDialog({ engine, onClose }: { engine: PosEngine; onClose: () => void }) {
  const [x, setX] = useState<any>(null);
  useEffect(() => { void engine.xReport().then(setX); }, [engine]);
  return <div className="modal-bg" onClick={onClose}><div className="modal" onClick={(e) => e.stopPropagation()}>
    <h2 style={{ margin: 0 }}>تقرير X</h2>
    {x ? <table><tbody>
      <tr><td>عدد الإيصالات</td><td className="num">{x.orders}</td></tr><tr><td>المبيعات</td><td className="num">{m2(x.sales)}</td></tr><tr><td>المرتجعات</td><td className="num">{m2(x.returns)}</td></tr>
      {Object.entries(x.tenders).map(([k, v]) => <tr key={k}><td>{k}</td><td className="num">{m2(v)}</td></tr>)}
      <tr><td>حركات نقدية</td><td className="num">{m2(x.cashMovements)}</td></tr><tr><td><strong>النقدية المتوقعة في الدرج</strong></td><td className="num"><strong>{m2(x.expectedCash)}</strong></td></tr>
    </tbody></table> : null}
    <button onClick={onClose}>إغلاق</button>
  </div></div>;
}

function CloseDialog({ engine, onClose, onClosed }: { engine: PosEngine; onClose: () => void; onClosed: () => void }) {
  const [counted, setCounted] = useState(''); const [z, setZ] = useState<any>(null); const [err, setErr] = useState('');
  return <div className="modal-bg"><div className="modal">
    <h2 style={{ margin: 0 }}>إغلاق الوردية (عدّ أعمى)</h2>
    {err ? <div className="err">{err}</div> : null}
    {!z ? <>
      <label>النقدية الفعلية في الدرج<input autoFocus inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} /></label>
      <div className="row"><button className="primary" disabled={!counted} onClick={async () => { try { setZ(await engine.closeSession(dec(counted).toFixed(2))); void engine.syncOnce().catch(() => undefined); } catch (e) { setErr(errMsg(e)); } }}>إغلاق</button><button onClick={onClose}>رجوع</button></div>
    </> : <>
      <table><tbody><tr><td>المتوقع</td><td className="num">{m2(z.expectedCash)}</td></tr><tr><td>الفعلي</td><td className="num">{m2(z.countedCash)}</td></tr><tr><td>الفرق</td><td className="num" style={{ color: Number(z.difference) < 0 ? 'var(--danger)' : undefined }}>{m2(z.difference)}</td></tr></tbody></table>
      <button className="primary" onClick={onClosed}>تم</button>
    </>}
  </div></div>;
}

function CashDialog({ engine, onClose }: { engine: PosEngine; onClose: () => void }) {
  const [kind, setKind] = useState<'cash_in' | 'cash_out' | 'safe_drop'>('safe_drop'); const [amount, setAmount] = useState(''); const [reason, setReason] = useState(''); const [err, setErr] = useState('');
  return <div className="modal-bg"><div className="modal">
    <h2 style={{ margin: 0 }}>حركة نقدية</h2>{err ? <div className="err">{err}</div> : null}
    <select value={kind} onChange={(e) => setKind(e.target.value as never)}><option value="safe_drop">إيداع في الخزينة</option><option value="cash_in">إضافة فكة</option><option value="cash_out">سحب</option></select>
    <input inputMode="decimal" placeholder="المبلغ" value={amount} onChange={(e) => setAmount(e.target.value)} /><input placeholder="السبب" value={reason} onChange={(e) => setReason(e.target.value)} />
    <div className="row"><button className="primary" disabled={!amount || !reason} onClick={async () => { try { await engine.cashMovement(kind, dec(amount).toFixed(2), reason); onClose(); } catch (e) { setErr(errMsg(e)); } }}>تسجيل</button><button onClick={onClose}>رجوع</button></div>
  </div></div>;
}

function OverrideDialog({ engine, onClose, onOk }: { engine: PosEngine; onClose: () => void; onOk: (u: PosUser) => void }) {
  const sups = engine.cashiers().filter((u) => u.pos_permissions.includes('pos.discount.override'));
  const [user, setUser] = useState(''); const [pin, setPin] = useState(''); const [err, setErr] = useState('');
  return <div className="modal-bg"><div className="modal">
    <h2 style={{ margin: 0 }}>موافقة المشرف</h2>{err ? <div className="err">{err}</div> : null}
    <select value={user} onChange={(e) => setUser(e.target.value)}><option value="">المشرف</option>{sups.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}</select>
    <input type="password" inputMode="numeric" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value)} placeholder="الرقم السري" />
    <div className="row"><button className="primary" onClick={async () => { const u = sups.find((x) => x.id === user); if (u?.pos_pin_hash && (await verify(u.pos_pin_hash, pin))) onOk(u); else setErr('رقم سري غير صحيح'); }}>موافقة</button><button onClick={onClose}>رجوع</button></div>
  </div></div>;
}

function ReturnDialog({ engine, onClose, onStart }: { engine: PosEngine; onClose: () => void; onStart: (order: any, lines: CartLine[]) => void }) {
  const [no, setNo] = useState(''); const [order, setOrder] = useState<any>(null); const [qtys, setQtys] = useState<Record<string, string>>({}); const [avail, setAvail] = useState<Record<string, number>>({}); const [err, setErr] = useState('');
  const find = async () => {
    setErr(''); const o = await engine.findLocalOrder(no.trim());
    if (!o) return setErr('الإيصال غير موجود على هذا الجهاز — المرتجع بدون إيصال يتطلب اتصالًا وموافقة');
    const a: Record<string, number> = {};
    for (const l of o.lines) a[l.lineId] = Number(l.qty) - (await engine.returnedQty(l.lineId));
    setAvail(a); setOrder(o);
  };
  return <div className="modal-bg"><div className="modal">
    <h2 style={{ margin: 0 }}>مرتجع بإيصال</h2>{err ? <div className="err">{err}</div> : null}
    <div className="row"><input placeholder="رقم الإيصال" value={no} onChange={(e) => setNo(e.target.value)} dir="ltr" /><button onClick={find}>بحث</button></div>
    {order ? <table><thead><tr><th>الصنف</th><th className="num">المتاح</th><th>كمية المرتجع</th></tr></thead><tbody>
      {order.lines.map((l: any) => <tr key={l.lineId}><td>{engine.variant(l.variantId)?.name_ar}</td><td className="num">{avail[l.lineId]}</td><td><input inputMode="decimal" value={qtys[l.lineId] ?? ''} onChange={(e) => setQtys({ ...qtys, [l.lineId]: e.target.value })} /></td></tr>)}
    </tbody></table> : null}
    <div className="row">
      <button className="primary" disabled={!order} onClick={() => {
        const ls: CartLine[] = order.lines.filter((l: any) => Number(qtys[l.lineId]) > 0).map((l: any) => {
          if (Number(qtys[l.lineId]) > avail[l.lineId]!) throw new Error('الكمية أكبر من المتاح');
          return { ...engine.newLine(l.variantId, qtys[l.lineId]!), unitPrice: l.unitPrice, priceListItemId: l.priceListItemId, manualDiscountPercent: null, returnOfLineId: l.lineId };
        });
        if (ls.length) onStart(order, ls);
      }}>بدء المرتجع</button><button onClick={onClose}>رجوع</button>
    </div>
  </div></div>;
}

function Receipt({ engine, order }: { engine: PosEngine; order: any }) {
  if (!order) return null;
  const t = engine.config?.terminal ?? {};
  return <div className="receipt" dir="rtl">
    <div style={{ textAlign: 'center' }}><strong>{t.legal_name_ar}</strong><br />{t.branch_name_ar}<br />{t.address ?? ''}<br />س.ض: {t.tax_registration_no ?? '—'}</div>
    {order.reprint ? <div style={{ textAlign: 'center' }}>*** نسخة ***</div> : null}
    <div>{order.kind === 'return' ? 'إيصال مرتجع' : 'إيصال بيع'} {order.receiptNo}<br />{new Date(order.soldAt).toLocaleString('ar-EG', { timeZone: 'Africa/Cairo' })}</div>
    <table><tbody>{order.lines.map((l: any) => <tr key={l.lineId}><td>{engine.variant(l.variantId)?.name_ar}<br />{l.qty} × {m2(l.unitPrice)}</td><td className="num">{m2(l.total)}</td></tr>)}</tbody></table>
    <div>الخصم: {m2(order.discountTotal)}<br />ضريبة القيمة المضافة: {m2(order.taxTotal)}<br /><strong>الإجمالي: {m2(order.grandTotal)}</strong></div>
    {order.payments.map((p: any) => <div key={p.id}>{p.method}: {m2(p.amount)}</div>)}
    <div>الباقي: {m2(order.change)}</div>
    <div style={{ textAlign: 'center' }}>شكرًا لزيارتكم</div>
  </div>;
}
