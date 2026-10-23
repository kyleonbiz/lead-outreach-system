"use client";

import { useState } from "react";
import { DocumentManagementPage } from "@/components/dms/document-management-page";
import { createLocalApi } from "@/lib/dms/client/local-api";

/** Public demo: the real UI and service running on in-browser sample data. */
export function DemoWorkspace() {
  const [api] = useState(createLocalApi);
  return <DocumentManagementPage api={api} />;
}
