import { Daytona } from "@daytonaio/sdk";
import axios from "axios";

type AxiosLikeInstance = {
  defaults?: {
    adapter?: unknown;
  };
};

type DaytonaAxiosFactoryTarget = {
  createAxiosInstance?: (...args: unknown[]) => AxiosLikeInstance;
};

function resolveFetchAdapter(): NonNullable<typeof axios.defaults.adapter> {
  return axios.getAdapter("fetch");
}

export function preferFetchAdapterForAxiosInstance(instance: AxiosLikeInstance): void {
  if (!instance.defaults) return;

  const adapter = instance.defaults.adapter;
  if (Array.isArray(adapter)) {
    instance.defaults.adapter = resolveFetchAdapter();
    return;
  }

  if (
    adapter === undefined ||
    adapter === null ||
    adapter === "fetch" ||
    adapter === "http" ||
    adapter === "xhr"
  ) {
    instance.defaults.adapter = resolveFetchAdapter();
  }
}

let daytonaFetchFirstAdapterConfigured = false;

export function configureDaytonaFetchFirstAdapter(): void {
  if (daytonaFetchFirstAdapterConfigured) return;
  axios.defaults.adapter = resolveFetchAdapter();

  const daytonaCtor = Daytona as unknown as DaytonaAxiosFactoryTarget & {
    prototype?: DaytonaAxiosFactoryTarget;
  };
  const target =
    typeof daytonaCtor.prototype?.createAxiosInstance === "function"
      ? daytonaCtor.prototype
      : daytonaCtor;
  const originalFactory = target.createAxiosInstance;
  if (typeof originalFactory !== "function") return;

  target.createAxiosInstance = function createAxiosInstanceFetchFirst(
    this: unknown,
    ...args: unknown[]
  ) {
    const instance = originalFactory.apply(this, args);
    preferFetchAdapterForAxiosInstance(instance);
    return instance;
  };
  daytonaFetchFirstAdapterConfigured = true;
}
