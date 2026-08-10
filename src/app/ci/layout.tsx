import { CiSectionNav } from "@/components/ci-section-nav";

export default function CiLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <CiSectionNav />
      {children}
    </>
  );
}
