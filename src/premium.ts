const PREMIUM_ICON_TYPE = 'YOUTUBE_PREMIUM_LOGO';

function premiumLogoIsActive(): boolean {
  const initialData = (window as typeof window & {
    ytInitialData?: {
      topbar?: {
        desktopTopbarRenderer?: {
          logo?: { topbarLogoRenderer?: { iconImage?: { iconType?: string } } };
        };
      };
    };
  }).ytInitialData;
  return initialData?.topbar?.desktopTopbarRenderer?.logo
    ?.topbarLogoRenderer?.iconImage?.iconType === PREMIUM_ICON_TYPE;
}

export async function isPremiumAccount(): Promise<boolean> {
  if (premiumLogoIsActive()) return true;
  if (document.readyState === 'loading') {
    await new Promise<void>((resolve) => {
      document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
    });
  }
  return premiumLogoIsActive();
}
