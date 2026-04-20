import { requireOptionalNativeModule } from 'expo';

export interface BatchContact {
  firstName?: string;
  lastName?: string;
  phoneNumbers?: { label?: string; number: string }[];
  emails?: { label?: string; email: string }[];
  company?: string;
  jobTitle?: string;
}

interface ContactsBatchNativeModule {
  addContactsBatch(contacts: BatchContact[]): Promise<string[]>;
}

const nativeModule = requireOptionalNativeModule<ContactsBatchNativeModule>('ContactsBatch');

export function isBatchAvailable(): boolean {
  return !!nativeModule;
}

export async function addContactsBatch(contacts: BatchContact[]): Promise<string[]> {
  if (!nativeModule) throw new Error('ContactsBatch native module not available (use dev client build)');
  return nativeModule.addContactsBatch(contacts);
}
