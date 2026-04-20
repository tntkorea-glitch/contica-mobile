import { requireOptionalNativeModule } from 'expo';

export interface CallLogEntry {
  number: string;
  name: string | null;
  timestamp: number;
  type: 'incoming' | 'outgoing' | 'missed' | 'voicemail' | 'rejected' | 'blocked' | 'other';
  duration: number;
}

export interface SmsEntry {
  number: string;
  name: string | null;
  timestamp: number;
  body: string;
  type: 'inbox' | 'sent' | 'draft' | 'outbox' | 'failed' | 'queued' | 'other';
}

interface PhoneHistoryNativeModule {
  getCallLog(limit?: number): Promise<CallLogEntry[]>;
  getSmsLog(limit?: number): Promise<SmsEntry[]>;
  requestPermissions(): Promise<{ callLog: boolean; sms: boolean }>;
  getPermissions(): Promise<{ callLog: boolean; sms: boolean }>;
}

const nativeModule = requireOptionalNativeModule<PhoneHistoryNativeModule>('PhoneHistory');

export function isPhoneHistoryAvailable(): boolean {
  return !!nativeModule;
}

export async function requestPhoneHistoryPermissions() {
  if (!nativeModule) throw new Error('PhoneHistory native module not available');
  return nativeModule.requestPermissions();
}

export async function getPhoneHistoryPermissions() {
  if (!nativeModule) throw new Error('PhoneHistory native module not available');
  return nativeModule.getPermissions();
}

export async function getCallLog(limit = 1000): Promise<CallLogEntry[]> {
  if (!nativeModule) throw new Error('PhoneHistory native module not available');
  return nativeModule.getCallLog(limit);
}

export async function getSmsLog(limit = 1000): Promise<SmsEntry[]> {
  if (!nativeModule) throw new Error('PhoneHistory native module not available');
  return nativeModule.getSmsLog(limit);
}
