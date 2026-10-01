import Image from "next/image";

/** Marka simgesi; uygulama adı yanındaki dinamik metinden okunur. */
export function BrandMark({ size = 32 }: { size?: 24 | 32 | 48 }) {
  return (
    <Image
      src="/brand-mark-adm.png"
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
    />
  );
}
