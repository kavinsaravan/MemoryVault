export type Config = {
  url: string;
  secretKey: string;
  userId: string;
  userEmail: string;
  mode: "protected" | "baseline";
};

export function loadConfig(): Config {
  const required = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const mode = process.env.MEMORYVAULT_MODE ?? "protected";
  if (mode !== "protected" && mode !== "baseline") throw new Error("MEMORYVAULT_MODE must be protected or baseline");
  return {
    url: required("SUPABASE_URL"),
    secretKey: required("SUPABASE_SECRET_KEY"),
    userId: required("MEMORYVAULT_USER_ID"),
    userEmail: required("MEMORYVAULT_USER_EMAIL"),
    mode,
  };
}
