const RTL_LANGUAGES = new Set(["AR", "HE", "FA", "UR"]);

export function rtlFor(code: string | null | undefined): "rtl" | "auto" {
  return code && RTL_LANGUAGES.has(code.toUpperCase()) ? "rtl" : "auto";
}