import { Login } from "../_components/login";
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ email?: string; workspace?: string }> }) {
  const params = await searchParams;
  return <Login initialEmail={typeof params.email === "string" ? params.email : ""} initialWorkspace={typeof params.workspace === "string" ? params.workspace : ""} />;
}
