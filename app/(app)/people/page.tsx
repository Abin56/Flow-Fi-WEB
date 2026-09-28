import { Suspense } from "react";
import { PeopleWorkspace } from "@/features/people/components/people-workspace";

export default function PeoplePage() {
  // `PeopleWorkspace` reads `?person=` with `useSearchParams`, which needs a Suspense boundary.
  return (
    <Suspense>
      <PeopleWorkspace />
    </Suspense>
  );
}
