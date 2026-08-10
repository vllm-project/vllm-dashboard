import { redirect } from "next/navigation";

export default function CiPage() {
  redirect("/ci/builds");
}
