// Resonant Spectra — the rig driver.
//
// Finds every light build_stage.py placed (by tag), groups them into rigs
// (one per photograph), and every tick applies the conductor's state to the
// active rig using the same formulas the web app uses for its light layer:
//
//   washes   base × Mid  × (0.85 + 0.45·T)
//   beams    base × Treb × gate(T ≥ ignite) × (0.55 + 0.45·T)      (+ flash)
//   plumes   base × Bass × (0.15 + 0.85·T²)                         (lagged up the column)
//   photo    emissive 'Glow' follows presence                        (+ flash)
//
// Releases advance to the next rig with a cross-fade. At BeginPlay it stops
// any Level Sequence player so the two systems never fight.

#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "ResonantRigDriver.generated.h"

class ULightComponent;
class UMeshComponent;
class UMaterialInstanceDynamic;
class UResonantConductorComponent;

UENUM()
enum class EResonantLightKind : uint8 { Wash, Beam, Plume };

USTRUCT()
struct FResonantRigLight
{
    GENERATED_BODY()
    TWeakObjectPtr<ULightComponent> Light;
    float Base = 0.f;
    float Ignite = 0.2f;
    EResonantLightKind Kind = EResonantLightKind::Wash;
    int32 PlumeIndex = 0;
};

USTRUCT()
struct FResonantRig
{
    GENERATED_BODY()
    FName Name;
    TArray<FResonantRigLight> Lights;
    TArray<TWeakObjectPtr<UMeshComponent>> PhotoMeshes;
    UPROPERTY() TArray<TObjectPtr<UMaterialInstanceDynamic>> PhotoMIDs;
};

UCLASS()
class RESONANTSPECTRA_API AResonantRigDriver : public AActor
{
    GENERATED_BODY()

public:
    AResonantRigDriver();

    UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "Resonant")
    TObjectPtr<UResonantConductorComponent> Conductor;

    /** Stop any Level Sequence players at BeginPlay so the driver owns the lights. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Resonant") bool bStopSequencesOnBeginPlay = true;
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Resonant") float CrossfadeSeconds = 1.6f;
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Resonant") float PhotoGlow = 0.28f;
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Resonant") int32 StartRig = 0;
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Resonant") bool bCycle = true;

    UPROPERTY(BlueprintReadOnly, Category = "Resonant|State") int32 CurrentRig = 0;
    UPROPERTY(BlueprintReadOnly, Category = "Resonant|State") int32 RigCount = 0;

    UFUNCTION(BlueprintCallable, Category = "Resonant") void NextRig();
    UFUNCTION(BlueprintCallable, Category = "Resonant") void PrevRig();
    UFUNCTION(BlueprintCallable, Category = "Resonant") void GoToRig(int32 Index);
    UFUNCTION(BlueprintCallable, Category = "Resonant") FName GetRigName(int32 Index) const;

    virtual void BeginPlay() override;
    virtual void Tick(float DeltaTime) override;

private:
    UPROPERTY() TArray<FResonantRig> Rigs;
    int32 PrevRigIdx = -1;
    float Fade = 0.f;         // 1 → 0 over CrossfadeSeconds after a switch
    double SwitchTime = -100.0;

    void Discover();
    void ApplyRig(FResonantRig& Rig, float Weight, bool bIsCurrent);
    void Silence(FResonantRig& Rig);
    void Switch(int32 NewIdx);

    UFUNCTION() void HandleRelease();
};
