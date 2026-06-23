import { useEffect, useState } from "react";
import { api } from "@/api/client";
import type { HealthResponse } from "@/api/types";

export function useHealth() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    api.health()
      .then(setHealth)
      .catch(() => setHealth(null))
      .finally(() => setChecking(false));
  }, []);

  return { health, checking };
}
