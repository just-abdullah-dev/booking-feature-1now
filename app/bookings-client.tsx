"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export interface Resource {
  id: string;
  name: string;
}

export interface Booking {
  id: string;
  resource_id: string;
  guest_name: string;
  start_at: string;
  end_at: string;
  status: "active" | "cancelled";
}

export interface TimeSlot {
  start: string;
  end: string;
}

interface ConflictInfo {
  conflicting: Booking;
  requestedStart: string;
  requestedEnd: string;
}

interface BookingsClientProps {
  initialResources: Resource[];
  initialBookings: Booking[];
}

function formatUtcTime(isoString: string): string {
  try {
    const d = new Date(isoString);
    return d.toLocaleTimeString("en-US", {
      timeZone: "UTC",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return isoString;
  }
}

function formatUtcDate(isoString: string): string {
  try {
    const d = new Date(isoString);
    return d.toLocaleDateString("en-US", {
      timeZone: "UTC",
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return isoString;
  }
}

function formatDuration(startIso: string, endIso: string): string {
  try {
    const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
    const minutes = Math.round(ms / (1000 * 60));
    const hours = Math.floor(minutes / 60);
    const remainingMins = minutes % 60;
    if (hours === 0) return `${minutes}m`;
    if (remainingMins === 0) return `${hours}h`;
    return `${hours}h ${remainingMins}m`;
  } catch {
    return "";
  }
}

export function BookingsClient({
  initialResources,
  initialBookings,
}: BookingsClientProps) {
  const router = useRouter();

  // Resource selection
  const [resources, setResources] = useState<Resource[]>(initialResources);
  const [selectedResourceId, setSelectedResourceId] = useState<string>(
    initialResources[0]?.id || ""
  );
  const [showAddRoom, setShowAddRoom] = useState(false);
  const [newRoomName, setNewRoomName] = useState("");
  const [addingRoom, setAddingRoom] = useState(false);

  // Bookings list state
  const [bookings, setBookings] = useState<Booking[]>(initialBookings);

  // Create booking form state
  const [guestName, setGuestName] = useState("");
  const [date, setDate] = useState("2026-10-16");
  const [startTime, setStartTime] = useState("13:00");
  const [endTime, setEndTime] = useState("14:00");

  // Status and feedback states
  const [submitting, setSubmitting] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);
  const [suggestedSlots, setSuggestedSlots] = useState<TimeSlot[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const selectedResource = resources.find(
    (r) => r.id === selectedResourceId
  );

  async function handleAddRoom(e: React.FormEvent) {
    e.preventDefault();
    if (!newRoomName.trim()) return;

    setAddingRoom(true);
    setErrorMessage(null);

    try {
      const res = await fetch("/api/resources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newRoomName.trim() }),
      });

      if (res.ok) {
        const data = await res.json();
        setResources((prev) => [...prev, data.resource]);
        setSelectedResourceId(data.resource.id);
        setNewRoomName("");
        setShowAddRoom(false);
        setSuccessMessage(`Room "${data.resource.name}" created successfully!`);
      } else {
        const data = await res.json();
        setErrorMessage(data.error || "Failed to create room");
      }
    } catch {
      setErrorMessage("Network error: failed to create room");
    } finally {
      setAddingRoom(false);
    }
  }

  // Active bookings for the currently selected resource, sorted chronologically
  const activeBookings = bookings
    .filter((b) => b.resource_id === selectedResourceId && b.status === "active")
    .sort(
      (a, b) =>
        new Date(a.start_at).getTime() - new Date(b.start_at).getTime()
    );

  // Reset feedback notifications
  const clearNotifications = () => {
    setSuccessMessage(null);
    setErrorMessage(null);
    setConflict(null);
    setSuggestedSlots([]);
  };

  // Form submit handler
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    clearNotifications();

    if (!selectedResourceId) {
      setErrorMessage("Please select a resource.");
      return;
    }
    if (!guestName.trim()) {
      setErrorMessage("Please enter guest name.");
      return;
    }

    const startAt = `${date}T${startTime}:00Z`;
    const endAt = `${date}T${endTime}:00Z`;

    if (new Date(endAt).getTime() <= new Date(startAt).getTime()) {
      setErrorMessage("End time must be after start time.");
      return;
    }

    await executeBooking(selectedResourceId, guestName.trim(), startAt, endAt);
  }

  // Booking action using POST /api/bookings
  async function executeBooking(
    resourceId: string,
    guest: string,
    startAt: string,
    endAt: string
  ) {
    setSubmitting(true);
    setErrorMessage(null);

    try {
      const res = await fetch("/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resourceId,
          guestName: guest,
          startAt,
          endAt,
        }),
      });

      if (res.status === 201) {
        const data = await res.json();
        setBookings((prev) =>
          [...prev, data.booking].sort(
            (a, b) =>
              new Date(a.start_at).getTime() - new Date(b.start_at).getTime()
          )
        );
        setConflict(null);
        setSuggestedSlots([]);
        setGuestName("");
        setSuccessMessage(
          `Booking confirmed for ${data.booking.guest_name} (${formatUtcTime(
            data.booking.start_at
          )} – ${formatUtcTime(data.booking.end_at)} UTC)`
        );
        router.refresh();
      } else if (res.status === 409) {
        const data = await res.json();
        setConflict({
          conflicting: data.conflicting,
          requestedStart: startAt,
          requestedEnd: endAt,
        });

        // Fetch deterministic slot suggestions using GET /api/bookings/[id]/suggest-slots
        setLoadingSuggestions(true);
        try {
          const suggestRes = await fetch(
            `/api/bookings/${resourceId}/suggest-slots?startAt=${encodeURIComponent(
              startAt
            )}&endAt=${encodeURIComponent(endAt)}`
          );
          if (suggestRes.ok) {
            const suggestData = await suggestRes.json();
            setSuggestedSlots(suggestData.slots || []);
          }
        } catch {
          // ignore suggestion fetch error
        } finally {
          setLoadingSuggestions(false);
        }
      } else {
        const data = await res.json().catch(() => ({}));
        setErrorMessage(
          data.message || `Booking failed with status ${res.status}`
        );
      }
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "Network error occurred."
      );
    } finally {
      setSubmitting(false);
    }
  }

  // One-click booking for a suggested slot
  async function handleBookSuggested(slot: TimeSlot) {
    clearNotifications();
    const guest = guestName.trim() || "Guest";
    await executeBooking(selectedResourceId, guest, slot.start, slot.end);

    // Sync input fields to selected slot
    const startD = new Date(slot.start);
    const endD = new Date(slot.end);
    setDate(startD.toISOString().slice(0, 10));
    setStartTime(startD.toISOString().slice(11, 16));
    setEndTime(endD.toISOString().slice(11, 16));
  }

  // Cancel booking action using PATCH /api/bookings/[id]/cancel
  async function handleCancel(bookingId: string, name: string) {
    if (!confirm(`Cancel booking for ${name}? This will free the slot.`)) {
      return;
    }

    clearNotifications();
    setCancellingId(bookingId);

    try {
      const res = await fetch(`/api/bookings/${bookingId}/cancel`, {
        method: "PATCH",
      });

      if (res.ok) {
        setBookings((prev) => prev.filter((b) => b.id !== bookingId));
        setSuccessMessage(
          `Booking for ${name} cancelled. The slot has been freed.`
        );
        router.refresh();
      } else {
        const data = await res.json().catch(() => ({}));
        setErrorMessage(data.message || "Failed to cancel booking.");
      }
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "Error cancelling booking."
      );
    } finally {
      setCancellingId(null);
    }
  }

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      {/* Top Header */}
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-md bg-zinc-900 text-xs font-bold text-white">
                1N
              </span>
              <h1 className="text-lg font-semibold tracking-tight text-zinc-900">
                Booking Conflict Guard
              </h1>
            </div>
            <p className="text-xs text-zinc-500">
              PostgreSQL Exclusion Constraint (`btree_gist`) Source of Truth
            </p>
          </div>

          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <span className="inline-flex h-2 w-2 rounded-full bg-emerald-500"></span>
            <span>All times evaluated in UTC</span>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="mx-auto max-w-6xl px-6 py-8">
        {/* Resource Selector Bar */}
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between rounded-xl border border-zinc-200 bg-white p-4 shadow-xs">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs font-medium uppercase tracking-wider text-zinc-500">
              Select Resource:
            </span>
            <div className="flex flex-wrap items-center gap-1.5 rounded-lg bg-zinc-100 p-1">
              {resources.map((resource) => (
                <button
                  key={resource.id}
                  type="button"
                  onClick={() => {
                    setSelectedResourceId(resource.id);
                    clearNotifications();
                  }}
                  className={`rounded-md px-4 py-1.5 text-sm font-medium cursor-pointer transition-colors ${
                    selectedResourceId === resource.id
                      ? "bg-zinc-900 text-white shadow-xs"
                      : "text-zinc-600 hover:text-zinc-900"
                  }`}
                >
                  {resource.name}
                </button>
              ))}

              {!showAddRoom ? (
                <button
                  type="button"
                  onClick={() => setShowAddRoom(true)}
                  className="flex items-center gap-1 rounded-md border border-dashed border-zinc-300 px-3 py-1.5 text-xs font-semibold text-zinc-600 hover:border-zinc-400 hover:bg-white hover:text-zinc-900 transition-colors"
                >
                  <span className="text-sm leading-none">+</span> Add Room
                </button>
              ) : (
                <form onSubmit={handleAddRoom} className="flex items-center gap-1.5 pl-1">
                  <input
                    type="text"
                    value={newRoomName}
                    onChange={(e) => setNewRoomName(e.target.value)}
                    placeholder="e.g. Room B"
                    autoFocus
                    className="h-8 rounded-md border border-zinc-300 bg-white px-2.5 text-xs text-zinc-900 focus:border-zinc-500 focus:outline-hidden"
                  />
                  <button
                    type="submit"
                    disabled={addingRoom || !newRoomName.trim()}
                    className="h-8 rounded-md bg-zinc-900 px-3 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
                  >
                    {addingRoom ? "Adding..." : "Save"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowAddRoom(false);
                      setNewRoomName("");
                    }}
                    className="h-8 rounded-md px-2 text-xs text-zinc-500 hover:text-zinc-800"
                  >
                    ✕
                  </button>
                </form>
              )}
            </div>
          </div>

          <div className="text-xs text-zinc-500">
            Active Bookings:{" "}
            <span className="font-semibold text-zinc-900">
              {activeBookings.length}
            </span>{" "}
            in {selectedResource?.name || "Selected"}
          </div>
        </div>

        {/* Global Success / Error Banners */}
        {successMessage && (
          <div className="mb-6 flex items-start justify-between rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-emerald-900">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-emerald-600 font-bold">✓</span>
              <span>{successMessage}</span>
            </div>
            <button
              onClick={() => setSuccessMessage(null)}
              className="text-xs font-semibold text-emerald-700 hover:text-emerald-900"
            >
              Dismiss
            </button>
          </div>
        )}

        {errorMessage && (
          <div className="mb-6 flex items-start justify-between rounded-lg border border-rose-200 bg-rose-50 p-4 text-rose-900">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-rose-600 font-bold">✕</span>
              <span>{errorMessage}</span>
            </div>
            <button
              onClick={() => setErrorMessage(null)}
              className="text-xs font-semibold text-rose-700 hover:text-rose-900"
            >
              Dismiss
            </button>
          </div>
        )}

        <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
          {/* Left Column: Create Booking Form + Conflict & Suggestions */}
          <div className="lg:col-span-5 flex flex-col gap-6">
             {/* Conflict & Suggested Slots Section */}
            {conflict && (
              <div className="rounded-xl border border-rose-300 bg-rose-50/70 p-5 shadow-xs">
                <div className="flex items-start gap-2.5">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-rose-600 text-xs font-bold text-white">
                    !
                  </span>
                  <div>
                    <h3 className="text-sm font-semibold text-rose-900">
                      Double-Booking Rejected (SQLSTATE 23P01)
                    </h3>
                    <p className="mt-1 text-xs text-rose-800 leading-relaxed">
                      Database constraint blocked this request. It conflicts
                      with an active booking for{" "}
                      <span className="font-bold underline">
                        {conflict.conflicting.guest_name}
                      </span>{" "}
                      ({formatUtcTime(conflict.conflicting.start_at)} –{" "}
                      {formatUtcTime(conflict.conflicting.end_at)} UTC).
                    </p>
                  </div>
                </div>

                {/* Suggested Slots */}
                <div className="mt-4 border-t border-rose-200/80 pt-3">
                  <p className="text-xs font-semibold text-rose-950">
                    Suggested Nearest Slots (Same Duration):
                  </p>
                  <p className="text-[11px] text-rose-700">
                    One click immediately reserves the slot.
                  </p>

                  {loadingSuggestions ? (
                    <div className="mt-3 text-xs text-rose-700 animate-pulse">
                      Calculating nearest available gaps...
                    </div>
                  ) : suggestedSlots.length === 0 ? (
                    <div className="mt-2 text-xs text-rose-700">
                      No nearby slots found within search window.
                    </div>
                  ) : (
                    <div className="mt-3 flex flex-col gap-2">
                      {suggestedSlots.map((slot, index) => (
                        <button
                          key={index}
                          type="button"
                          onClick={() => handleBookSuggested(slot)}
                          className="group flex items-center justify-between rounded-lg border border-rose-300 bg-white px-3.5 py-2 text-left text-xs font-medium text-zinc-900 transition-all hover:border-zinc-900 hover:bg-zinc-900 hover:text-white"
                        >
                          <div>
                            <span className="font-bold">
                              {formatUtcTime(slot.start)} – {formatUtcTime(slot.end)}{" "}
                              UTC
                            </span>
                            <span className="ml-2 text-zinc-500 group-hover:text-zinc-300">
                              ({formatUtcDate(slot.start)})
                            </span>
                          </div>
                          <span className="rounded bg-rose-100 px-2 py-0.5 text-[10px] font-semibold text-rose-800 group-hover:bg-zinc-800 group-hover:text-white">
                            Book in 1-Click →
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
            <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-xs">
              <h2 className="text-base font-semibold text-zinc-900">
                Create Booking
              </h2>
              <p className="mt-1 text-xs text-zinc-500">
                Attempts to insert into PostgreSQL. Overlaps are strictly
                rejected by the exclusion constraint.
              </p>

              <form onSubmit={handleSubmit} className="mt-5 space-y-4">
                {/* Resource field */}
                <div>
                  <label className="block text-xs font-medium text-zinc-700">
                    Resource
                  </label>
                  <select
                    value={selectedResourceId}
                    onChange={(e) => {
                      setSelectedResourceId(e.target.value);
                      clearNotifications();
                    }}
                    className="mt-1 block w-full rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm text-zinc-900 focus:border-zinc-500 focus:bg-white focus:outline-hidden"
                  >
                    {initialResources.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Guest Name */}
                <div>
                  <label className="block text-xs font-medium text-zinc-700">
                    Guest Name
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Alice Smith"
                    value={guestName}
                    onChange={(e) => setGuestName(e.target.value)}
                    className="mt-1 block w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-hidden"
                  />
                </div>

                {/* Date */}
                <div>
                  <label className="block text-xs font-medium text-zinc-700">
                    Date (UTC)
                  </label>
                  <input
                    type="date"
                    required
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    className="mt-1 block w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-900 focus:border-zinc-500 focus:outline-hidden"
                  />
                </div>

                {/* Start & End Times */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-zinc-700">
                      Start Time (UTC)
                    </label>
                    <input
                      type="time"
                      required
                      value={startTime}
                      onChange={(e) => setStartTime(e.target.value)}
                      className="mt-1 block w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-900 focus:border-zinc-500 focus:outline-hidden"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-zinc-700">
                      End Time (UTC)
                    </label>
                    <input
                      type="time"
                      required
                      value={endTime}
                      onChange={(e) => setEndTime(e.target.value)}
                      className="mt-1 block w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-900 focus:border-zinc-500 focus:outline-hidden"
                    />
                  </div>
                </div>

                {/* Submit button */}
                <button
                  type="submit"
                  disabled={submitting}
                  className="mt-2 w-full rounded-lg bg-zinc-900 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-zinc-800 disabled:bg-zinc-400"
                >
                  {submitting ? "Checking & Booking..." : "Create Booking"}
                </button>
              </form>

              {/* Demo Quick Fills */}
              <div className="mt-5 border-t border-zinc-100 pt-4">
                <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-400">
                  Demo Shortcuts
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setGuestName("Eve (Overlap Tester)");
                      setDate("2026-10-16");
                      setStartTime("10:30");
                      setEndTime("11:30");
                    }}
                    className="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100"
                  >
                    ⚡ Test Conflict (10:30–11:30)
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setGuestName("David (Free Slot)");
                      setDate("2026-10-16");
                      setStartTime("13:00");
                      setEndTime("14:00");
                    }}
                    className="rounded-md border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100"
                  >
                    ⚡ Test Free (13:00–14:00)
                  </button>
                </div>
              </div>
            </div>

           
          </div>

          {/* Right Column: Timeline / Active Bookings List */}
          <div className="lg:col-span-7">
            <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-xs">
              <div className="flex items-center justify-between border-b border-zinc-100 pb-4">
                <div>
                  <h2 className="text-base font-semibold text-zinc-900">
                    Timeline & Bookings
                  </h2>
                  <p className="text-xs text-zinc-500">
                    Active reservations for{" "}
                    <span className="font-semibold text-zinc-800">
                      {selectedResource?.name}
                    </span>
                  </p>
                </div>
                <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-700">
                  {activeBookings.length} Active
                </span>
              </div>

              {activeBookings.length === 0 ? (
                <div className="py-16 text-center">
                  <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-zinc-100 text-lg">
                    📅
                  </div>
                  <h3 className="mt-3 text-sm font-medium text-zinc-900">
                    No active bookings
                  </h3>
                  <p className="mt-1 text-xs text-zinc-500">
                    All slots are currently free on {selectedResource?.name}.
                  </p>
                </div>
              ) : (
                <div className="mt-6 space-y-4">
                  {activeBookings.map((b, idx) => {
                    const isCancelling = cancellingId === b.id;
                    return (
                      <div
                        key={b.id}
                        className="relative flex items-start gap-4 rounded-lg border border-zinc-200 bg-zinc-50/50 p-4 transition-colors hover:border-zinc-300 hover:bg-white"
                      >
                        {/* Timeline index / indicator */}
                        <div className="flex flex-col items-center">
                          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-zinc-900 text-[10px] font-bold text-white">
                            {idx + 1}
                          </span>
                        </div>

                        {/* Booking Details */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <h4 className="text-sm font-semibold text-zinc-900 truncate">
                              {b.guest_name}
                            </h4>
                            <span className="inline-flex items-center rounded-md bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 ring-1 ring-inset ring-emerald-600/20">
                              Active
                            </span>
                          </div>

                          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-600">
                            <span className="font-medium text-zinc-900">
                              {formatUtcTime(b.start_at)} – {formatUtcTime(b.end_at)} UTC
                            </span>
                            <span>•</span>
                            <span>{formatUtcDate(b.start_at)}</span>
                            <span>•</span>
                            <span className="text-zinc-500">
                              Duration: {formatDuration(b.start_at, b.end_at)}
                            </span>
                          </div>
                        </div>

                        {/* Cancel Button */}
                        <div className="shrink-0">
                          <button
                            type="button"
                            disabled={isCancelling}
                            onClick={() => handleCancel(b.id, b.guest_name)}
                            className="rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-700 transition-colors disabled:opacity-50"
                          >
                            {isCancelling ? "Cancelling..." : "Cancel"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
