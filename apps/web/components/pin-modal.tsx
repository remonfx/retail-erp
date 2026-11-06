'use client';
import { useState } from 'react';
import { post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useAction, ErrorBox, Ok, Modal, Field } from '@/components/ui';

export /** Each user sets their own 6-digit POS PIN (confirmed with their password); it syncs to terminals as an Argon2 hash. */
function PinModal({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [pin, setPin] = useState(''); const [password, setPassword] = useState('');
  const a = useAction();
  return <Modal title="POS PIN" onClose={onClose}><ErrorBox error={a.error} /><Ok msg={a.ok} />
    <div className="form-grid">
      <Field label="PIN (6)"><input type="password" inputMode="numeric" maxLength={6} pattern="\d{6}" value={pin} onChange={(e) => setPin(e.target.value)} /></Field>
      <Field label={t('password')}><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
    </div>
    <div style={{ marginTop: 12 }}><button className="btn primary" disabled={a.busy || !/^\d{6}$/.test(pin) || !password} onClick={() => a.run(async () => { await post('/api/v1/auth/pos-pin', { pin, password }); setPin(''); setPassword(''); }, t('saved'))}>{t('save')}</button></div>
  </Modal>;
}

