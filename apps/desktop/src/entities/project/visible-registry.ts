import { useEffect, useState } from "react";
import {
  getProjectRegistry,
  subscribeProjectRegistry,
} from "@/entities/project/project-registry";
import { getProjectRegistryWithBrowserDevelopmentFallback } from "@/shared/browser-development-data";

export function getVisibleProjectRegistry() {
  return getProjectRegistryWithBrowserDevelopmentFallback(getProjectRegistry());
}

export function useVisibleProjectRegistry() {
  const [projects, setProjects] = useState(() => getVisibleProjectRegistry());

  useEffect(
    () => subscribeProjectRegistry(() => setProjects(getVisibleProjectRegistry())),
    [],
  );

  return projects;
}
