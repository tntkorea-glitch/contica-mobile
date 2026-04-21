export const MAIN_USER_ID = '85f67042-f584-493e-98d5-d695d27152e5';
export const MAIN_USER_EMAIL = 'tntkorea@tntkorea.co.kr';

export function isMainAccountId(userId: string | null | undefined): boolean {
  return !!userId && userId === MAIN_USER_ID;
}
