import { defaultUploadLimits } from "../config";
import type { UploadLimits } from "../types";

export function loadUploadLimitsForBrowser(): UploadLimits {
  return defaultUploadLimits();
}
