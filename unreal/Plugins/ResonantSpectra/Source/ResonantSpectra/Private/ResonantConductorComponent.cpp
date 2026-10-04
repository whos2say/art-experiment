#include "ResonantConductorComponent.h"
#include "Sound/SoundSubmix.h"
#include "Sound/AudioSettings.h"
#include "Engine/World.h"

UResonantConductorComponent::UResonantConductorComponent()
{
    PrimaryComponentTick.bCanEverTick = true;
    PrimaryComponentTick.TickGroup = TG_PrePhysics;   // before the driver applies us
}

float UResonantConductorComponent::SmoothStep(float A, float B, float X)
{
    X = FMath::Clamp((X - A) / (B - A), 0.f, 1.f);
    return X * X * (3.f - 2.f * X);
}

void UResonantConductorComponent::BeginPlay()
{
    Super::BeginPlay();

    // 48 log-spaced analysis frequencies, 40 Hz .. 16 kHz
    Freqs.Reset(); Mags.Reset(); PrevMags.Reset();
    const int32 N = 48;
    for (int32 i = 0; i < N; ++i)
    {
        const float t = float(i) / float(N - 1);
        Freqs.Add(40.f * FMath::Pow(16000.f / 40.f, t));
    }
    Mags.Init(0.f, N); PrevMags.Init(0.f, N);

    if (!Submix)
    {
        if (const UAudioSettings* Settings = GetDefault<UAudioSettings>())
        {
            Submix = Cast<USoundSubmix>(Settings->MasterSubmix.TryLoad());
        }
    }
    if (Submix)
    {
        Submix->StartSpectralAnalysis(this, EFFTSize::Large, EFFTPeakInterpolationMethod::Linear,
                                      EFFTWindowType::Hann, 0.02f, EAudioSpectrumType::MagnitudeSpectrum);
        bAnalysing = true;
    }
    else
    {
        UE_LOG(LogTemp, Warning, TEXT("[ResonantSpectra] no submix to analyse — running the timed movement only"));
    }
    HoldStart = GetWorld()->GetTimeSeconds();
}

void UResonantConductorComponent::TickComponent(float Dt, ELevelTick TickType, FActorComponentTickFunction* Tf)
{
    Super::TickComponent(Dt, TickType, Tf);
    Dt = FMath::Min(Dt, 0.05f);
    const double Now = GetWorld()->GetTimeSeconds();

    // ── read the spectrum ────────────────────────────────────────────────────
    float Energy = 0.f;
    if (bAnalysing && Submix)
    {
        Submix->GetMagnitudeForFrequencies(this, Freqs, Mags);
        for (float M : Mags) Energy += M;
        Energy /= float(Mags.Num());
    }
    if (Energy > 2e-4f) LastSignal = Now;
    bAudioActive = (Now - LastSignal) < 0.6;

    // the movement clock resets the moment audio arrives (v2 fix: avoids a spurious release on the first audio frame)
    if (bAudioActive && !bWasActive) { HoldStart = Now; Hist.Reset(); CooldownLeft = FMath::Max(CooldownLeft, 1.0f); }
    bWasActive = bAudioActive;

    auto Gain = [Dt](float& G, float X) { G = FMath::Max(X, G - G * 0.06f * Dt); return G > 1e-6f ? FMath::Min(1.f, X / G) : 0.f; };

    if (bAudioActive)
    {
        // bands
        float B = 0, Bn = 0, Mi = 0, Mn = 0, T = 0, Tn = 0;
        for (int32 i = 0; i < Mags.Num(); ++i)
        {
            const float f = Freqs[i], m = Mags[i];
            if (f < 250.f) { B += m; Bn++; } else if (f < 4000.f) { Mi += m; Mn++; } else { T += m; Tn++; }
        }
        B /= FMath::Max(1.f, Bn); Mi /= FMath::Max(1.f, Mn); T /= FMath::Max(1.f, Tn);
        Bass = 0.4f + 1.3f * Gain(GainB, B);
        Mid  = 0.6f + 1.0f * Gain(GainM, Mi);
        Treb = 0.4f + 1.4f * Gain(GainT, T);

        // energy + spectral centroid + onset flux → target tension (same weights as the web app)
        float Num = 0, Den = 0, Flux = 0;
        for (int32 i = 0; i < Mags.Num(); ++i)
        {
            Num += i * Mags[i]; Den += Mags[i];
            const float d = Mags[i] - PrevMags[i]; if (d > 0) Flux += d;
        }
        const float Cent = Den > 0 ? (Num / Den) / float(Mags.Num()) : 0.f;
        Flux /= float(Mags.Num());
        PrevMags = Mags;

        const float nE = Gain(GainE, Energy), nC = Gain(GainC, Cent), nF = Gain(GainF, Flux);
        const float Target = 0.5f * nE + 0.2f * nC + 0.3f * nF;
        const float K = Target > Tension ? (1.f - FMath::Exp(-Dt / 0.28f)) : (1.f - FMath::Exp(-Dt / 0.9f)); // rise fast, fall slow
        Tension += (Target - Tension) * K;
        MovementProgress = 0.f;
    }
    else
    {
        // no music: the timed movement, exactly as the web app without audio
        const float P = FMath::Clamp(float((Now - HoldStart) / MovementSeconds), 0.f, 1.f);
        MovementProgress = P;
        Tension = SmoothStep(.12f, .55f, P) * (1.f - SmoothStep(.8f, 1.f, P));
        Bass = Mid = Treb = 0.9f + 0.1f * FMath::Sin(float(Now) * 3.f);
        if (P >= 1.f) { Release(false); }
    }

    // ── release detection ────────────────────────────────────────────────────
    Hist.Add({ Now, Tension });
    while (Hist.Num() && Now - Hist[0].T > 1.8) Hist.RemoveAt(0, 1, EAllowShrinking::No);
    CooldownLeft -= Dt;
    Flash = FMath::Max(0.f, Flash - Dt * 1.7f);

    if (bAudioActive && CooldownLeft <= 0.f)
    {
        const float VAgo = Hist.Num() ? Hist[0].V : Tension;
        float RecentMax = 0.f; for (const FHist& H : Hist) RecentMax = FMath::Max(RecentMax, H.V);
        const float Slope = Tension - VAgo;
        const double Held = Now - HoldStart;
        if ((RecentMax > ReleasePeak && Slope < -ReleaseDrop) || Held > MaxHoldSeconds)
        {
            Release(true);
        }
    }
}

void UResonantConductorComponent::Release(bool bDoFlash)
{
    if (bDoFlash) Flash = 1.f;
    CooldownLeft = ReleaseCooldown;
    Hist.Reset();
    HoldStart = GetWorld()->GetTimeSeconds();
    OnRelease.Broadcast();
}

void UResonantConductorComponent::ForceRelease() { Release(true); }
void UResonantConductorComponent::RestartMovement() { HoldStart = GetWorld()->GetTimeSeconds(); Hist.Reset(); }
