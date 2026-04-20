import { requireOptionalNativeModule } from 'expo';

export interface BatchContact {
  firstName?: string;
  lastName?: string;
  phoneNumbers?: { label?: string; number: string }[];
  emails?: { label?: string; email: string }[];
  company?: string;
  jobTitle?: string;
  /** 폰 Groups 테이블의 _ID (string으로 전달, 내부에서 Long 변환) */
  groupIds?: string[];
}

export interface PhoneGroup {
  id: string;
  title: string;
}

interface ContactsBatchNativeModule {
  addContactsBatch(contacts: BatchContact[]): Promise<string[]>;
  getPhoneGroups(): Promise<PhoneGroup[]>;
  createPhoneGroup(title: string): Promise<string>;
}

const nativeModule = requireOptionalNativeModule<ContactsBatchNativeModule>('ContactsBatch');

export function isBatchAvailable(): boolean {
  return !!nativeModule;
}

export async function addContactsBatch(contacts: BatchContact[]): Promise<string[]> {
  if (!nativeModule) throw new Error('ContactsBatch native module not available (use dev client build)');
  return nativeModule.addContactsBatch(contacts);
}

export async function getPhoneGroups(): Promise<PhoneGroup[]> {
  if (!nativeModule) throw new Error('ContactsBatch native module not available');
  return nativeModule.getPhoneGroups();
}

export async function createPhoneGroup(title: string): Promise<string> {
  if (!nativeModule) throw new Error('ContactsBatch native module not available');
  return nativeModule.createPhoneGroup(title);
}
