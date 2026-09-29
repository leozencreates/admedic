import {
  Bell,
  Bot,
  Building2,
  Calculator,
  ChartColumn,
  ClipboardCheck,
  FlaskConical,
  House,
  Images,
  Inbox,
  Languages,
  Layers,
  Lightbulb,
  Megaphone,
  Plug,
  Receipt,
  Rocket,
  Route,
  ScrollText,
  ShieldCheck,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import type { NavIcon } from "../_lib/nav-tree";

/** Menü ikonları (Lucide, ADR-0017). Süs amaçlıdır; her ikonun yanında görünür bir etiket vardır. */
const ICONS: Record<NavIcon, LucideIcon> = {
  home: House,
  approvals: ClipboardCheck,
  leads: Inbox,
  studio: Sparkles,
  library: Images,
  languages: Languages,
  tests: FlaskConical,
  calculator: Calculator,
  campaigns: Megaphone,
  planner: Route,
  insights: ChartColumn,
  recommendations: Lightbulb,
  decisions: Bot,
  alerts: Bell,
  clinic: Building2,
  meta: Plug,
  platforms: Layers,
  guard: ShieldCheck,
  rules: ScrollText,
  billing: Receipt,
  launch: Rocket,
};

export function NavGlyph({ icon, size = 18 }: { icon: NavIcon; size?: number }) {
  const Icon = ICONS[icon];
  return <Icon size={size} strokeWidth={1.75} aria-hidden="true" />;
}
