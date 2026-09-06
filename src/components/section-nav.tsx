"use client";

import { usePathname } from "next/navigation";
import { Tabs } from "@/components/tabs";
import {
  activeLinkForPathname,
  sectionForPathname,
} from "@/lib/dashboard-navigation";

/**
 * The section shell shared by every page inside a section: eyebrow label,
 * one-line description, and the section's view tabs. The Overview page has no
 * section and renders nothing here.
 */
export function SectionNav() {
  const pathname = usePathname();
  const section = sectionForPathname(pathname);

  if (!section) return null;

  const active = activeLinkForPathname(section, pathname);

  return (
    <div className="mb-6">
      <div className="mb-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
          {section.label}
        </p>
        <p className="mt-1 text-xs text-muted">{section.description}</p>
      </div>
      <Tabs
        label={`${section.label} views`}
        size="sm"
        value={active?.href ?? ""}
        items={section.links.map((link) => ({
          value: link.href,
          label: link.label,
          href: link.href,
        }))}
      />
    </div>
  );
}
