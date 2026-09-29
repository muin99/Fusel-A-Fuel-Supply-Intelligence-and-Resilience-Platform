import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // minimal self-contained server for the Docker image
  output: "standalone",
  // monorepo: trace dependencies from the workspace root
  outputFileTracingRoot: path.resolve(process.cwd(), "../.."),
};

export default nextConfig;
