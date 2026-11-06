import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { api, enqueue, flushQueue, queueSize } from '../api';
import { Btn, Card, ErrorText, Input, T } from '../ui';

/** Offline-capable counting: every scan is queued locally and flushed with idempotency keys. */
export function Stocktake() {
  const [counts, setCounts] = useState<any[]>([]); const [count, setCount] = useState<any>(null);
  const [perm, requestPerm] = useCameraPermissions();
  const [qty, setQty] = useState('1'); const [last, setLast] = useState<string | null>(null); const [pending, setPending] = useState(0); const [error, setError] = useState<string | null>(null);
  const [scanOn, setScanOn] = useState(false); const [lastScanAt, setLastScanAt] = useState(0);
  useEffect(() => { api('GET', '/api/v1/stock-counts?state=counting').then(setCounts).catch((e) => setError(e.message)); void queueSize().then(setPending); }, []);
  const record = async (code: string) => {
    if (Date.now() - lastScanAt < 1200) return; setLastScanAt(Date.now());
    setError(null);
    try {
      const hit = await api('GET', `/api/v1/barcodes/${encodeURIComponent(code)}`);
      const q = hit.match === 'embedded' && hit.valueType === 'weight' ? hit.value : String(Number(qty) * Number(hit.pack_qty ?? 1));
      setPending(await enqueue(`/api/v1/stock-counts/${count.id}/entries`, { entries: [{ variantId: hit.variant_id, countedQty: q, mode: 'add' }] }));
      setLast(`${hit.name_ar} +${q}`);
      void flushQueue().then((r) => setPending(r.left)).catch(() => undefined);
    } catch (e) { setError(`${code}: ${(e as Error).message}`); }
  };
  if (!count) return <View style={{ gap: 10 }}>
    <ErrorText error={error} />
    {!counts.length ? <T muted>لا يوجد جرد مفتوح — أنشئه من لوحة الويب</T> : null}
    {counts.map((c) => <Card key={c.id}><T bold>{c.number}</T><T muted>{c.location_code} — {c.counted}/{c.lines}</T><Btn title="بدء العد" kind="primary" onPress={() => setCount(c)} /></Card>)}
  </View>;
  return <View style={{ gap: 10 }}>
    <T bold>{count.number}</T>
    <T muted>في الانتظار (أوفلاين): {pending}</T>
    <View style={{ flexDirection: 'row-reverse', gap: 8, alignItems: 'center' }}><T>الكمية لكل مسح</T><View style={{ width: 90 }}><Input keyboardType="decimal-pad" value={qty} onChangeText={setQty} /></View></View>
    {scanOn ? <View style={{ height: 260, borderRadius: 12, overflow: 'hidden' }}><CameraView style={{ flex: 1 }} barcodeScannerSettings={{ barcodeTypes: ['ean13', 'ean8', 'upc_a', 'code128'] }} onBarcodeScanned={({ data }) => record(data)} /></View>
      : <Btn kind="primary" title="تشغيل الكاميرا" onPress={async () => { if (!perm?.granted) await requestPerm(); setScanOn(true); }} />}
    {last ? <T>آخر مسح: {last}</T> : null}
    <ErrorText error={error} />
    <Btn title="إرسال المعلّق الآن" onPress={async () => setPending((await flushQueue()).left)} />
    <Btn title="رجوع" onPress={() => setCount(null)} />
  </View>;
}
