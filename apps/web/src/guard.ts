import { useQuery } from "@tanstack/react-query";
import type { GuardStatus } from "@nana/shared";
import { api } from "./api";

export const useGuard = () => useQuery({ queryKey: ["guard"], queryFn: () => api<GuardStatus>("/guard") });
