#include "ResonantRigDriver.h"
#include "ResonantConductorComponent.h"
#include "Components/LightComponent.h"
#include "Components/MeshComponent.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "LevelSequenceActor.h"
#include "LevelSequencePlayer.h"
#include "EngineUtils.h"
#include "Engine/World.h"

namespace
{
    // tags written by build_stage.py:  rs_beam / rs_wash / rs_plume / rs_photo,  rig:<name>,  ignite:<0.20>,  plume:<i>
    bool TagValue(const AActor* A, const TCHAR* Prefix, FString& Out)
    {
        for (const FName& T : A->Tags)
        {
            const FString S = T.ToString();
            if (S.StartsWith(Prefix)) { Out = S.Mid(FCString::Strlen(Prefix)); return true; }
        }
        return false;
    }
    float SmoothStep(float A, float B, float X) { X = FMath::Clamp((X - A) / (B - A), 0.f, 1.f); return X * X * (3.f - 2.f * X); }
}

AResonantRigDriver::AResonantRigDriver()
{
    PrimaryActorTick.bCanEverTick = true;
    PrimaryActorTick.TickGroup = TG_DuringPhysics;      // after the conductor (TG_PrePhysics)
    Conductor = CreateDefaultSubobject<UResonantConductorComponent>(TEXT("Conductor"));
}

void AResonantRigDriver::BeginPlay()
{
    Super::BeginPlay();
    Discover();
    if (bStopSequencesOnBeginPlay)
    {
        for (TActorIterator<ALevelSequenceActor> It(GetWorld()); It; ++It)
        {
            if (ULevelSequencePlayer* P = It->GetSequencePlayer()) { P->Stop(); }
        }
    }
    for (FResonantRig& R : Rigs) Silence(R);
    if (Rigs.Num())
    {
        CurrentRig = FMath::Clamp(StartRig, 0, Rigs.Num() - 1);
        PrevRigIdx = -1; Fade = 0.f;
        SwitchTime = GetWorld()->GetTimeSeconds();   // the first rig emerges rather than snapping on
    }
    Conductor->OnRelease.AddDynamic(this, &AResonantRigDriver::HandleRelease);
    Conductor->RestartMovement();
    UE_LOG(LogTemp, Log, TEXT("[ResonantSpectra] driver: %d rigs discovered"), Rigs.Num());
}

void AResonantRigDriver::Discover()
{
    Rigs.Reset();
    TMap<FName, int32> Index;
    auto RigFor = [&](const FString& Name) -> FResonantRig&
    {
        const FName Key(*Name);
        if (int32* I = Index.Find(Key)) return Rigs[*I];
        FResonantRig R; R.Name = Key; Index.Add(Key, Rigs.Add(R)); return Rigs.Last();
    };
    for (TActorIterator<AActor> It(GetWorld()); It; ++It)
    {
        AActor* A = *It;
        if (!A->Tags.Contains(FName("rs_stage"))) continue;
        FString RigName; if (!TagValue(A, TEXT("rig:"), RigName)) continue;

        if (A->Tags.Contains(FName("rs_photo")))
        {
            if (UMeshComponent* M = A->FindComponentByClass<UMeshComponent>())
            {
                FResonantRig& R = RigFor(RigName);
                R.PhotoMeshes.Add(M);
                R.PhotoMIDs.Add(M->CreateDynamicMaterialInstance(0));
            }
            continue;
        }
        ULightComponent* L = A->FindComponentByClass<ULightComponent>();
        if (!L) continue;
        FResonantRigLight RL; RL.Light = L; RL.Base = L->Intensity;
        // prefer the design intensity build_stage.py recorded: a sequence may already have zeroed the light this frame
        FString BaseTag; if (TagValue(A, TEXT("base:"), BaseTag)) RL.Base = FCString::Atof(*BaseTag);
        if (A->Tags.Contains(FName("rs_beam")))
        {
            RL.Kind = EResonantLightKind::Beam;
            FString Ig; if (TagValue(A, TEXT("ignite:"), Ig)) RL.Ignite = FCString::Atof(*Ig);
        }
        else if (A->Tags.Contains(FName("rs_plume")))
        {
            RL.Kind = EResonantLightKind::Plume;
            FString Pi; if (TagValue(A, TEXT("plume:"), Pi)) RL.PlumeIndex = FCString::Atoi(*Pi);
        }
        else RL.Kind = EResonantLightKind::Wash;
        RigFor(RigName).Lights.Add(RL);
    }
    Rigs.Sort([](const FResonantRig& A, const FResonantRig& B) { return A.Name.LexicalLess(B.Name); });
    RigCount = Rigs.Num();
}

void AResonantRigDriver::Silence(FResonantRig& Rig)
{
    for (FResonantRigLight& L : Rig.Lights) if (L.Light.IsValid()) L.Light->SetIntensity(0.f);
    for (UMaterialInstanceDynamic* M : Rig.PhotoMIDs) if (M) M->SetScalarParameterValue(TEXT("Glow"), 0.f);
}

void AResonantRigDriver::ApplyRig(FResonantRig& Rig, float W, bool bIsCurrent)
{
    const float T = Conductor->Tension, Bass = Conductor->Bass, Mid = Conductor->Mid, Treb = Conductor->Treb;
    const float Flash = bIsCurrent ? Conductor->Flash : 0.f;
    for (FResonantRigLight& L : Rig.Lights)
    {
        if (!L.Light.IsValid()) continue;
        float V = 0.f;
        switch (L.Kind)
        {
        case EResonantLightKind::Wash:
            V = L.Base * Mid * (0.85f + 0.45f * T); break;
        case EResonantLightKind::Beam:
        {
            const float Gate = SmoothStep(L.Ignite, L.Ignite + 0.18f, T);
            V = L.Base * Treb * Gate * (0.55f + 0.45f * T) + L.Base * 0.9f * Flash; break;
        }
        case EResonantLightKind::Plume:
        {
            const float Tl = FMath::Max(0.f, T - 0.05f * L.PlumeIndex);
            V = L.Base * Bass * (0.15f + 0.85f * Tl * Tl); break;
        }
        }
        L.Light->SetIntensity(V * W);
    }
    const float Glow = (PhotoGlow * (0.8f + 0.4f * T) + 0.6f * Flash) * W;
    for (UMaterialInstanceDynamic* M : Rig.PhotoMIDs) if (M) M->SetScalarParameterValue(TEXT("Glow"), Glow);
}

void AResonantRigDriver::Tick(float Dt)
{
    Super::Tick(Dt);
    if (!Rigs.IsValidIndex(CurrentRig)) return;
    const double Now = GetWorld()->GetTimeSeconds();
    Fade = FMath::Max(0.f, 1.f - float((Now - SwitchTime) / CrossfadeSeconds));
    const float Emerge = SmoothStep(0.f, 1.4f, float(Now - SwitchTime));
    ApplyRig(Rigs[CurrentRig], Emerge, true);
    if (Rigs.IsValidIndex(PrevRigIdx) && PrevRigIdx != CurrentRig)
    {
        if (Fade > 0.f) ApplyRig(Rigs[PrevRigIdx], Fade, false);
        else { Silence(Rigs[PrevRigIdx]); PrevRigIdx = -1; }
    }
}

void AResonantRigDriver::Switch(int32 NewIdx)
{
    if (!Rigs.Num()) return;
    NewIdx = ((NewIdx % Rigs.Num()) + Rigs.Num()) % Rigs.Num();
    if (NewIdx == CurrentRig) return;
    if (Rigs.IsValidIndex(PrevRigIdx) && PrevRigIdx != NewIdx) Silence(Rigs[PrevRigIdx]);
    PrevRigIdx = CurrentRig; CurrentRig = NewIdx;
    SwitchTime = GetWorld()->GetTimeSeconds();
    Conductor->RestartMovement();
}

void AResonantRigDriver::HandleRelease() { if (bCycle) Switch(CurrentRig + 1); }
void AResonantRigDriver::NextRig() { Conductor->ForceRelease(); if (!bCycle) Switch(CurrentRig + 1); }
void AResonantRigDriver::PrevRig() { Switch(CurrentRig - 1); }
void AResonantRigDriver::GoToRig(int32 Index) { Switch(Index); }
FName AResonantRigDriver::GetRigName(int32 Index) const { return Rigs.IsValidIndex(Index) ? Rigs[Index].Name : NAME_None; }
