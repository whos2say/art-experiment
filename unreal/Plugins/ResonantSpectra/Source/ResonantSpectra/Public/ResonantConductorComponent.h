// Resonant Spectra — the conductor.
//
// A port of computeConductor() from the web app. Every tick it reads the
// spectrum of a submix (the master submix by default — i.e. everything the
// game is playing), and turns it into:
//
//   Bass / Mid / Treb   band levels, auto-gained to the track's own dynamics
//   Tension             one normalised 0..1 "how far into the build are we"
//   Flash               a decaying pulse that fires on release
//   OnRelease           fires when a peak collapses (the jam resolves), when a
//                       movement has been held too long, or on ForceRelease()
//
// With no audio playing it falls back to the same timed movement curve the
// web app uses, so a stage always performs.

#pragma once

#include "CoreMinimal.h"
#include "Components/ActorComponent.h"
#include "ResonantConductorComponent.generated.h"

class USoundSubmix;

DECLARE_DYNAMIC_MULTICAST_DELEGATE(FOnResonantRelease);

UCLASS(ClassGroup = (ResonantSpectra), meta = (BlueprintSpawnableComponent))
class RESONANTSPECTRA_API UResonantConductorComponent : public UActorComponent
{
    GENERATED_BODY()

public:
    UResonantConductorComponent();

    /** Submix to analyse. Leave empty for the project's master submix (all game audio). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Resonant|Audio")
    TObjectPtr<USoundSubmix> Submix = nullptr;

    /** Movement length when no audio is playing (seconds). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Resonant|Timing", meta = (ClampMin = "4", ClampMax = "120"))
    float MovementSeconds = 24.f;

    /** Force a release if a jam never resolves (seconds). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Resonant|Timing")
    float MaxHoldSeconds = 60.f;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Resonant|Release") float ReleaseCooldown = 4.5f;
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Resonant|Release") float ReleasePeak = 0.80f;
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Resonant|Release") float ReleaseDrop = 0.22f;

    // ── live outputs ────────────────────────────────────────────────────────
    UPROPERTY(BlueprintReadOnly, Category = "Resonant|State") float Bass = 1.f;
    UPROPERTY(BlueprintReadOnly, Category = "Resonant|State") float Mid = 1.f;
    UPROPERTY(BlueprintReadOnly, Category = "Resonant|State") float Treb = 1.f;
    UPROPERTY(BlueprintReadOnly, Category = "Resonant|State") float Tension = 0.f;
    UPROPERTY(BlueprintReadOnly, Category = "Resonant|State") float Flash = 0.f;
    /** True while the submix carries signal (last ~0.6 s). */
    UPROPERTY(BlueprintReadOnly, Category = "Resonant|State") bool bAudioActive = false;
    /** 0..1 progress of the current timed movement (only meaningful when !bAudioActive). */
    UPROPERTY(BlueprintReadOnly, Category = "Resonant|State") float MovementProgress = 0.f;

    UPROPERTY(BlueprintAssignable, Category = "Resonant")
    FOnResonantRelease OnRelease;

    /** Release now: flash, cooldown, restart the movement clock. */
    UFUNCTION(BlueprintCallable, Category = "Resonant")
    void ForceRelease();

    /** Restart the movement clock without a flash (e.g. after jumping to a rig). */
    UFUNCTION(BlueprintCallable, Category = "Resonant")
    void RestartMovement();

    virtual void BeginPlay() override;
    virtual void TickComponent(float DeltaTime, ELevelTick TickType, FActorComponentTickFunction* ThisTickFunction) override;

private:
    struct FHist { double T; float V; };

    TArray<float> Freqs;      // analysis frequencies (log-spaced)
    TArray<float> Mags;       // current magnitudes
    TArray<float> PrevMags;   // for spectral flux
    TArray<FHist> Hist;       // ~1.8 s of tension, for release slope

    // decaying peaks: everything is relative to the track's own dynamics
    float GainE = 1e-4f, GainC = 1e-4f, GainF = 1e-4f, GainB = 1e-4f, GainM = 1e-4f, GainT = 1e-4f;
    double HoldStart = 0.0;
    double LastSignal = -10.0;
    float CooldownLeft = 0.f;
    bool bAnalysing = false;
    bool bWasActive = false;

    void Release(bool bFlash);
    static float SmoothStep(float A, float B, float X);
};
