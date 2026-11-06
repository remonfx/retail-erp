import { useState } from 'react';
import { View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { api } from '../api';
import { Btn, Card, ErrorText, Input, T, money } from '../ui';

export function Lookup() {
  const [perm, requestPerm] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [code, setCode] = useState(''); const [res, setRes] = useState<any>(null); const [stock, setStock] = useState<any[]>([]); const [error, setError] = useState<string | null>(null);
  const find = async (c: string) => {
    setError(null); setScanning(false); setCode(c);
    try {
      const hit = await api('GET', `/api/v1/barcodes/${encodeURIComponent(c)}`).catch(async () => { const r = await api('GET', `/api/v1/products?q=${encodeURIComponent(c)}&limit=1`); if (!r.data[0]) throw new Error('غير موجود'); return { variant_id: r.data[0].id, sku: r.data[0].sku, name_ar: r.data[0].name_ar }; });
      const prod = await api('GET', `/api/v1/products?q=${encodeURIComponent(hit.sku)}&limit=1`);
      setRes({ ...hit, retail_price: prod.data[0]?.retail_price });
      setStock(await api('GET', `/api/v1/stock/availability?variantIds=${hit.variant_id}`));
    } catch (e) { setRes(null); setError((e as Error).message); }
  };
  return <View style={{ gap: 12 }}>
    <View style={{ flexDirection: 'row-reverse', gap: 8 }}>
      <View style={{ flex: 1 }}><Input placeholder="باركود أو كود أو اسم" value={code} onChangeText={setCode} onSubmitEditing={() => find(code)} /></View>
      <Btn title="بحث" onPress={() => find(code)} />
    </View>
    {!scanning ? <Btn kind="primary" title="مسح بالكاميرا" onPress={async () => { if (!perm?.granted) await requestPerm(); setScanning(true); }} />
      : <View style={{ height: 260, borderRadius: 12, overflow: 'hidden' }}><CameraView style={{ flex: 1 }} barcodeScannerSettings={{ barcodeTypes: ['ean13', 'ean8', 'upc_a', 'code128'] }} onBarcodeScanned={({ data }) => find(data)} /></View>}
    <ErrorText error={error} />
    {res ? <Card>
      <T size={17} bold>{res.name_ar}</T><T muted>{res.sku}</T><T>السعر: {money(res.retail_price)}</T>
      {res.match === 'embedded' ? <T muted>ملصق ميزان: {res.value}</T> : null}
      {stock.map((s, i) => <T key={i}>فرع {String(s.branch_id).slice(-6)}: متاح {s.available} — محجوز {s.reserved}</T>)}
    </Card> : null}
  </View>;
}
