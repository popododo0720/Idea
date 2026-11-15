package main

import (
	"errors"
	"testing"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime"
	k8stesting "k8s.io/client-go/testing"
)

// The gate approves the review (one status write) and then merges with the
// Task it read before: the second write must not fail on the conflict, and
// must keep what the first one wrote.
func TestSetPhaseRetriesOnConflict(t *testing.T) {
	e := newEnv(t, gateTask(time.Minute, nil))
	name := taskName("idea/shop", 7)
	stale := e.task(t, name)
	if err := e.c.setPhase(t.Context(), stale, phaseGate, "review approved pull request #3",
		map[string]any{"reviewApproved": "abc123"}); err != nil {
		t.Fatal(err)
	}
	conflicts := 0
	e.dyn.PrependReactor("update", "tasks", func(a k8stesting.Action) (bool, runtime.Object, error) {
		if a.GetSubresource() == "status" && conflicts == 0 {
			conflicts++
			return true, nil, apierrors.NewConflict(taskGVR.GroupResource(), name, errors.New("the object has been modified"))
		}
		return false, nil, nil
	})
	if err := e.c.setPhase(t.Context(), stale, phaseDone, "pull request #3 merged", nil); err != nil {
		t.Fatalf("setPhase after a conflict: %v", err)
	}
	got := e.task(t, name)
	if conflicts != 1 || got.phase != phaseDone || got.message() != "pull request #3 merged" {
		t.Fatalf("conflicts=%d task %s %q", conflicts, got.phase, got.message())
	}
	if statusString(got, "reviewApproved") != "abc123" {
		t.Fatal("the retry dropped a status field written in between")
	}
}

func TestSetPhaseConflictTwice(t *testing.T) {
	e := newEnv(t, gateTask(time.Minute, nil))
	name := taskName("idea/shop", 7)
	e.dyn.PrependReactor("update", "tasks", func(a k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewConflict(taskGVR.GroupResource(), name, errors.New("the object has been modified"))
	})
	err := e.c.setPhase(t.Context(), e.task(t, name), phaseDone, "pull request #3 merged", nil)
	if !apierrors.IsConflict(err) {
		t.Fatalf("err = %v, want the conflict", err)
	}
}
